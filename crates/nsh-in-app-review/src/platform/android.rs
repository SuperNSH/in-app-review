//! Android: Google Play's In-App Review API over JNI.
//!
//! The app must bundle `com.google.android.play:review` 2.x, which also brings
//! `com.google.android.gms.tasks.Task`; this bridge invokes those classes over JNI and ships no
//! Java of its own. ndk-context carries the VM and the activity. Play answers through a Task,
//! which a Rust-only embedding cannot listen to — ART has no `DefineClass` and no play class
//! declares a native method — so a dedicated thread polls `isComplete` and calls `done` once,
//! whatever the answer.

use std::{
    ffi::c_void,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Mutex, PoisonError},
    thread,
    time::Duration,
};

use jni::{
    Env, JavaVM, jni_sig, jni_str,
    objects::{JObject, JString, JValue, LoaderContext},
};
use tokio::sync::oneshot;

use crate::{
    backend::{Backend, BackendFuture, ReviewDone},
    error::{ErrorKind, InAppReviewError},
    options::StoreListingOptions,
};

pub(crate) struct NativeBackend;

/// How often the watching thread asks Java whether a task finished. The card is paced by the
/// user, so a coarse poll reads no worse than a callback here.
const POLL: Duration = Duration::from_millis(200);

/// The stack of a JNI thread: ART's frames run deeper than a native thread's 2 MiB default, and
/// Play's calls reach well into Java.
const STACK: usize = 8 * 1024 * 1024;

/// Serializes the ndk-context probe: it swaps the panic hook, which is process-global.
static PROBE: Mutex<()> = Mutex::new(());

/// The activity reference ndk-context holds, moved into a worker thread. `Send` because a Java
/// global reference is valid on any thread. The borrow is sound while the host keeps the context
/// installed: a runtime that releases it (ndk-glue does, on activity destroy) deletes the
/// reference, so a release must not race a flow still in flight.
struct BorrowedActivity(*mut c_void);
// SAFETY: see the doc above; the raw pointer is a Java global reference.
unsafe impl Send for BorrowedActivity {}

impl BorrowedActivity {
    /// Reads the pointer, so a thread closure moves the whole wrapper — whose `Send` this is —
    /// and not its non-Send field.
    fn raw(self) -> *mut c_void {
        self.0
    }
}

impl From<jni::errors::Error> for InAppReviewError {
    // A JNI failure is the environment failing, never a flow answer; kinds that mean more are
    // mapped by hand where they occur.
    fn from(_: jni::errors::Error) -> Self {
        InAppReviewError::new(ErrorKind::Backend)
    }
}

/// Runs `call` and clears any Java exception it left pending. jni keeps a thrown exception set,
/// and the attach boundary converts a leftover into its own error, which outranks whatever this
/// module mapped the same failure to — so a converted failure must not carry one out.
fn clearing<'local, T>(
    env: &mut Env<'local>,
    call: impl FnOnce(&mut Env<'local>) -> jni::errors::Result<T>,
) -> jni::errors::Result<T> {
    let answer = call(&mut *env);
    if answer.is_err() && env.exception_check() {
        env.exception_clear();
    }
    answer
}

/// ndk-context's VM and activity, or `None` until the host runtime installs them. The getter
/// panics while nothing is installed, and panics again once a context is released — releasing
/// deletes the reference it lent — so every call probes fresh and the one panic is caught.
fn installed() -> Option<(JavaVM, *mut c_void)> {
    let _hold = PROBE.lock().unwrap_or_else(PoisonError::into_inner);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let probe = catch_unwind(AssertUnwindSafe(ndk_context::android_context));
    std::panic::set_hook(previous);
    let context = probe.ok()?;
    if context.vm().is_null() || context.context().is_null() {
        return None;
    }
    // SAFETY: ndk-context hands over the process's own VM, which outlives every caller.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) };
    Some((vm, context.context()))
}

/// ndk-context's activity as a `JObject`: a borrowed reference, sound under the condition
/// `BorrowedActivity` states — the host keeps the context installed for the whole call.
fn host_context<'local>(env: &mut Env<'local>, raw: *mut c_void) -> JObject<'local> {
    // SAFETY: the host-installed reference outlives this borrow; see `BorrowedActivity`.
    unsafe { JObject::from_raw(env, raw.cast()) }
}

/// `ReviewManagerFactory.create(context)`. Failing here — the library unbundled, Play refusing —
/// means the device has no review flow, which is `NotAvailable` rather than a broken environment.
///
/// The factory is resolved through the activity's loader: a natively attached thread's `FindClass`
/// sees only system classes, so an app-bundled class is invisible to a by-name lookup.
fn create_manager<'local>(
    env: &mut Env<'local>,
    context: &JObject<'_>,
) -> Result<JObject<'local>, InAppReviewError> {
    let factory = clearing(env, |env| {
        LoaderContext::FromObject(context).load_class(
            env,
            jni_str!("com.google.android.play.core.review.ReviewManagerFactory"),
            false,
        )
    })
    .map_err(|_| InAppReviewError::new(ErrorKind::NotAvailable))?;
    let manager = clearing(env, |env| {
        env.call_static_method(
            &factory,
            jni_str!("create"),
            jni_sig!(
                "(Landroid/content/Context;)Lcom/google/android/play/core/review/ReviewManager;"
            ),
            &[JValue::Object(context)],
        )
    })
    .map_err(|_| InAppReviewError::new(ErrorKind::NotAvailable))?
    .l()?;
    Ok(manager)
}

/// `requestReviewFlow()`: the task that fetches what a launch needs. Play reports a missing flow
/// by failing this task, so a call that throws is the same `NotAvailable`.
fn request_flow<'local>(
    env: &mut Env<'local>,
    manager: &JObject<'_>,
) -> Result<JObject<'local>, InAppReviewError> {
    let task = clearing(env, |env| {
        env.call_method(
            manager,
            jni_str!("requestReviewFlow"),
            jni_sig!("()Lcom/google/android/gms/tasks/Task;"),
            &[],
        )
    })
    .map_err(|_| InAppReviewError::new(ErrorKind::NotAvailable))?
    .l()?;
    Ok(task)
}

/// `launchReviewFlow(activity, info)`: the task that shows the card.
fn launch_flow<'local>(
    env: &mut Env<'local>,
    manager: &JObject<'_>,
    activity: &JObject<'_>,
    info: &JObject<'_>,
) -> Result<JObject<'local>, InAppReviewError> {
    let task = clearing(env, |env| {
        env.call_method(
            manager,
            jni_str!("launchReviewFlow"),
            jni_sig!("(Landroid/app/Activity;Lcom/google/android/play/core/review/ReviewInfo;)Lcom/google/android/gms/tasks/Task;"),
            &[JValue::Object(activity), JValue::Object(info)],
        )
    })?
    .l()?;
    Ok(task)
}

/// `Task.getResult()`: the fetched `ReviewInfo`, read only after the task succeeded.
fn review_info<'local>(
    env: &mut Env<'local>,
    task: &JObject<'_>,
) -> Result<JObject<'local>, InAppReviewError> {
    let info = clearing(env, |env| {
        env.call_method(
            task,
            jni_str!("getResult"),
            jni_sig!("()Ljava/lang/Object;"),
            &[],
        )
    })?
    .l()?;
    Ok(info)
}

fn is_complete(env: &mut Env<'_>, task: &JObject<'_>) -> Result<bool, InAppReviewError> {
    let answer = clearing(env, |env| {
        env.call_method(task, jni_str!("isComplete"), jni_sig!("()Z"), &[])
    })?;
    Ok(answer.z()?)
}

fn is_successful(env: &mut Env<'_>, task: &JObject<'_>) -> Result<bool, InAppReviewError> {
    let answer = clearing(env, |env| {
        env.call_method(task, jni_str!("isSuccessful"), jni_sig!("()Z"), &[])
    })?;
    Ok(answer.z()?)
}

/// Waits for the task's answer on this thread, parking between asks. Play answers when the user
/// is done with the card, however long that takes; this thread is the only one waiting.
fn wait_for(env: &mut Env<'_>, task: &JObject<'_>) -> Result<(), InAppReviewError> {
    while !is_complete(env, task)? {
        thread::sleep(POLL);
    }
    Ok(())
}

/// Whether Play serves this device a flow, by requesting one the way `in_app_review`'s plugin
/// probes. Every way the request says no — the library missing, Play refusing — is `Ok(false)`;
/// only a broken VM is an `Err`.
fn available(env: &mut Env<'_>, raw: *mut c_void) -> Result<bool, InAppReviewError> {
    let context = host_context(env, raw);
    let Ok(manager) = create_manager(env, &context) else {
        return Ok(false);
    };
    let Ok(task) = request_flow(env, &manager) else {
        return Ok(false);
    };
    wait_for(env, &task)?;
    is_successful(env, &task)
}

/// Runs the whole flow to its one answer: fetch the review info, then launch the card. The one
/// ndk-context object serves as both the manager's context and the launch activity.
fn flow(env: &mut Env<'_>, raw: *mut c_void) -> Result<bool, InAppReviewError> {
    let context = host_context(env, raw);
    let manager = create_manager(env, &context)?;
    let request = request_flow(env, &manager)?;
    wait_for(env, &request)?;
    if !is_successful(env, &request)? {
        return Err(InAppReviewError::new(ErrorKind::NotAvailable));
    }
    let info = review_info(env, &request)?;
    let launch = launch_flow(env, &manager, &context, &info)?;
    wait_for(env, &launch)?;
    if !is_successful(env, &launch)? {
        // A failed launch reports no code Play documents, so the error carries no status.
        return Err(InAppReviewError::new(ErrorKind::Backend));
    }
    Ok(true)
}

/// The Play listing URL of the running app, whose package id is the listing's id. `Ok(None)`
/// when the package cannot be read or is blank: either way there is no id to list.
fn listing(env: &mut Env<'_>, raw: *mut c_void) -> Result<Option<String>, InAppReviewError> {
    let context = host_context(env, raw);
    let name = clearing(env, |env| {
        env.call_method(
            &context,
            jni_str!("getPackageName"),
            jni_sig!("()Ljava/lang/String;"),
            &[],
        )
    })?
    .l()?;
    let name: JString = env.cast_local::<JString>(name)?;
    let package = name.try_to_string(env)?.trim().to_owned();
    Ok((!package.is_empty())
        .then(|| format!("https://play.google.com/store/apps/details?id={package}")))
}

impl Backend for NativeBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        Box::pin(async move {
            let Some((vm, activity)) = installed() else {
                return Err(InAppReviewError::new(ErrorKind::Backend));
            };
            let (sender, receiver) = oneshot::channel::<Result<bool, InAppReviewError>>();
            let activity = BorrowedActivity(activity);
            // The probe rides its own thread: the ask reaches the network and must not block
            // the caller's thread.
            let asked = thread::Builder::new()
                .name("nsh-in-app-review-probe".into())
                .stack_size(STACK)
                .spawn(move || {
                    // Attach failures come back as the same Err, via the From impl above.
                    let answer =
                        vm.attach_current_thread(move |env| available(env, activity.raw()));
                    let _ = sender.send(answer);
                });
            match asked {
                // A dropped sender means the probe thread died without answering.
                Ok(_) => match receiver.await {
                    Ok(answer) => answer,
                    Err(_) => Err(InAppReviewError::new(ErrorKind::Backend)),
                },
                Err(_) => Err(InAppReviewError::new(ErrorKind::Backend)),
            }
        })
    }

    /// Hands Play the flow. The launch task finishes the same way whether the user completed or
    /// dismissed the card — the API signals neither — so its completion is `Ok(true)` and
    /// `Ok(false)` for a dismissed flow does not exist on Android.
    fn start_review(&self, done: ReviewDone) -> Result<(), InAppReviewError> {
        let Some((vm, activity)) = installed() else {
            return Err(InAppReviewError::new(ErrorKind::Backend));
        };
        let activity = BorrowedActivity(activity);
        // An Err here means no thread started, so done stays uncalled; from here the thread's
        // single done call is the answer, whatever it is.
        thread::Builder::new()
            .name("nsh-in-app-review".into())
            .stack_size(STACK)
            .spawn(move || {
                // A panic must not swallow done — the caller would wait forever. No JNI runs
                // after a caught panic, so unwinding across these handles stays contained.
                let answer = catch_unwind(AssertUnwindSafe(move || {
                    vm.attach_current_thread(move |env| flow(env, activity.raw()))
                }))
                .unwrap_or_else(|_| Err(InAppReviewError::new(ErrorKind::Backend)));
                done(answer);
            })
            .map(|_| ())
            .map_err(|_| InAppReviewError::new(ErrorKind::Backend))
    }

    fn store_listing_url(
        &self,
        _options: &StoreListingOptions,
    ) -> Result<String, InAppReviewError> {
        // Android's listing id is the running app's package; no option carries it.
        let built = installed().and_then(|(vm, activity)| {
            vm.attach_current_thread(move |env| listing(env, activity))
                .ok()
                .flatten()
        });
        // An unreadable package is the id being unavailable, which is the same as missing.
        built.ok_or_else(|| InAppReviewError::new(ErrorKind::InvalidArgument))
    }
}
