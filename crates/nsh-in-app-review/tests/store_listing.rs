//! The store listing: each platform's URL rule, the id it requires, and the opener's failure.

use std::{
    future::{Future, ready},
    sync::Arc,
};

use nsh_in_app_review::{
    Backend, BackendFuture, ErrorKind, FakeBackend, FakeOpener, InAppReview, InAppReviewError,
    ReviewDone, StoreListingOptions,
};

fn run<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(future)
}

/// The platforms the CONTRACT names, one backend per rule: the real bridges sit behind target cfgs
/// these tests do not all run under, so each rule is restated here and what ships must match it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Store {
    Apple,
    Windows,
    Web,
    Android,
    Linux,
}

/// A backend that builds listing URLs by one platform's rule. Android's listing id is the running
/// app's package; this one stands in with a fixed package.
struct ListingBackend(Store);

/// The id trimmed; `None` when missing or blank. A blank id would build a URL to nowhere.
fn non_blank(id: Option<&str>) -> Option<&str> {
    let id = id?.trim();
    (!id.is_empty()).then_some(id)
}

impl ListingBackend {
    /// The options carrying `app_store_id`, as a test would spell them.
    fn apple_options() -> StoreListingOptions {
        StoreListingOptions {
            app_store_id: Some("123456789".to_owned()),
            microsoft_store_id: None,
        }
    }

    /// The options carrying `microsoft_store_id`, as a test would spell them.
    fn windows_options() -> StoreListingOptions {
        StoreListingOptions {
            app_store_id: None,
            microsoft_store_id: Some("9NBLGGH42NBS".to_owned()),
        }
    }
}

impl Backend for ListingBackend {
    fn is_available(&self) -> BackendFuture<'_, Result<bool, InAppReviewError>> {
        // Only Apple has a review flow among these; the listing tests never start one.
        Box::pin(ready(Ok::<bool, InAppReviewError>(self.0 == Store::Apple)))
    }

    fn start_review(&self, _done: ReviewDone) -> Result<(), InAppReviewError> {
        Err(InAppReviewError::new(ErrorKind::NotAvailable))
    }

    fn store_listing_url(&self, options: &StoreListingOptions) -> Result<String, InAppReviewError> {
        match self.0 {
            Store::Apple => non_blank(options.app_store_id.as_deref())
                .map(|id| format!("itms-apps://itunes.apple.com/app/id{id}?action=write-review"))
                .ok_or_else(|| InAppReviewError::new(ErrorKind::InvalidArgument)),
            Store::Windows => non_blank(options.microsoft_store_id.as_deref())
                .map(|id| format!("ms-windows-store://pdp/?ProductId={id}"))
                .ok_or_else(|| InAppReviewError::new(ErrorKind::InvalidArgument)),
            // Apple first: one listing wins when both ids are set.
            Store::Web => {
                if let Some(id) = non_blank(options.app_store_id.as_deref()) {
                    return Ok(format!("https://apps.apple.com/app/id{id}"));
                }
                non_blank(options.microsoft_store_id.as_deref())
                    .map(|id| format!("https://www.microsoft.com/store/productId/{id}"))
                    .ok_or_else(|| InAppReviewError::new(ErrorKind::InvalidArgument))
            }
            Store::Android => {
                Ok("https://play.google.com/store/apps/details?id=com.example.app".to_owned())
            }
            Store::Linux => Err(InAppReviewError::new(ErrorKind::NotAvailable)),
        }
    }
}

#[test]
fn open_store_listing_requires_app_store_id_on_apple() {
    let opener = FakeOpener::new();
    let review = InAppReview::new(
        Arc::new(ListingBackend(Store::Apple)),
        Arc::new(opener.clone()),
    );
    run(async {
        // Neither id, or the other platform's id alone, names an Apple listing.
        let none = review
            .open_store_listing(&StoreListingOptions::default())
            .await
            .unwrap_err();
        assert_eq!(none.kind(), ErrorKind::InvalidArgument);
        assert_eq!(none.code(), "ERR_IN_APP_REVIEW_INVALID_ARGUMENT");
        let wrong = review
            .open_store_listing(&ListingBackend::windows_options())
            .await
            .unwrap_err();
        assert_eq!(wrong.kind(), ErrorKind::InvalidArgument);
        assert_eq!(opener.last_opened(), None);

        review
            .open_store_listing(&ListingBackend::apple_options())
            .await
            .unwrap();
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("itms-apps://itunes.apple.com/app/id123456789?action=write-review")
        );
    });
}

#[test]
fn open_store_listing_requires_microsoft_store_id_on_windows() {
    let opener = FakeOpener::new();
    let review = InAppReview::new(
        Arc::new(ListingBackend(Store::Windows)),
        Arc::new(opener.clone()),
    );
    run(async {
        let none = review
            .open_store_listing(&StoreListingOptions::default())
            .await
            .unwrap_err();
        assert_eq!(none.kind(), ErrorKind::InvalidArgument);
        assert_eq!(none.code(), "ERR_IN_APP_REVIEW_INVALID_ARGUMENT");
        let wrong = review
            .open_store_listing(&ListingBackend::apple_options())
            .await
            .unwrap_err();
        assert_eq!(wrong.kind(), ErrorKind::InvalidArgument);
        assert_eq!(opener.last_opened(), None);

        review
            .open_store_listing(&ListingBackend::windows_options())
            .await
            .unwrap();
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("ms-windows-store://pdp/?ProductId=9NBLGGH42NBS")
        );
    });
}

#[test]
fn empty_store_ids_are_invalid_arguments() {
    let opener = FakeOpener::new();
    let apple = InAppReview::new(
        Arc::new(ListingBackend(Store::Apple)),
        Arc::new(opener.clone()),
    );
    let windows = InAppReview::new(
        Arc::new(ListingBackend(Store::Windows)),
        Arc::new(opener.clone()),
    );
    let web = InAppReview::new(
        Arc::new(ListingBackend(Store::Web)),
        Arc::new(opener.clone()),
    );
    // A blank id is the same as none, whatever whitespace it is blank with.
    let blanks = [
        StoreListingOptions {
            app_store_id: Some("   ".to_owned()),
            microsoft_store_id: None,
        },
        StoreListingOptions {
            app_store_id: None,
            microsoft_store_id: Some("\t".to_owned()),
        },
        StoreListingOptions {
            app_store_id: Some(" ".to_owned()),
            microsoft_store_id: Some(" ".to_owned()),
        },
    ];
    run(async {
        for options in &blanks {
            for review in [&apple, &windows, &web] {
                let error = review.open_store_listing(options).await.unwrap_err();
                assert_eq!(error.kind(), ErrorKind::InvalidArgument);
                assert_eq!(error.code(), "ERR_IN_APP_REVIEW_INVALID_ARGUMENT");
            }
        }
        // Nothing was ever handed to the opener.
        assert_eq!(opener.last_opened(), None);
    });
}

#[test]
fn store_listing_urls_match_the_platform_stores() {
    let opener = FakeOpener::new();
    let opens =
        |store: Store| InAppReview::new(Arc::new(ListingBackend(store)), Arc::new(opener.clone()));
    run(async {
        opens(Store::Apple)
            .open_store_listing(&ListingBackend::apple_options())
            .await
            .unwrap();
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("itms-apps://itunes.apple.com/app/id123456789?action=write-review")
        );

        opens(Store::Windows)
            .open_store_listing(&ListingBackend::windows_options())
            .await
            .unwrap();
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("ms-windows-store://pdp/?ProductId=9NBLGGH42NBS")
        );

        // The web takes either id, Apple's first when both are set.
        opens(Store::Web)
            .open_store_listing(&ListingBackend::apple_options())
            .await
            .unwrap();
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("https://apps.apple.com/app/id123456789")
        );
        opens(Store::Web)
            .open_store_listing(&ListingBackend::windows_options())
            .await
            .unwrap();
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("https://www.microsoft.com/store/productId/9NBLGGH42NBS")
        );

        // Android's listing is the running app's package.
        opens(Store::Android)
            .open_store_listing(&StoreListingOptions::default())
            .await
            .unwrap();
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("https://play.google.com/store/apps/details?id=com.example.app")
        );

        // Linux has no store to open: `Err(NotAvailable)`, and the opener stays untouched.
        let refused = opens(Store::Linux)
            .open_store_listing(&StoreListingOptions::default())
            .await
            .unwrap_err();
        assert_eq!(refused.kind(), ErrorKind::NotAvailable);
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("https://play.google.com/store/apps/details?id=com.example.app")
        );
    });
}

#[test]
fn open_store_listing_surfaces_a_backend_error_when_the_opener_fails() {
    let fake = FakeBackend::new();
    let opener = FakeOpener::new();
    let review = InAppReview::new(Arc::new(fake.clone()), Arc::new(opener.clone()));
    run(async {
        opener.fail_next_open();
        let error = review
            .open_store_listing(&StoreListingOptions::default())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Backend);
        assert_eq!(error.code(), "ERR_IN_APP_REVIEW_BACKEND");
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("https://example.com/store-listing")
        );

        // A URL that cannot be built never reaches the opener.
        fake.set_listing_url(Err(InAppReviewError::new(ErrorKind::InvalidArgument)));
        let refused = review
            .open_store_listing(&StoreListingOptions::default())
            .await
            .unwrap_err();
        assert_eq!(refused.kind(), ErrorKind::InvalidArgument);
        assert_eq!(
            opener.last_opened().as_deref(),
            Some("https://example.com/store-listing")
        );
    });
}

/// The real apple bridge, as TSX reaches it through `NativeInAppReview`: the bridge compiles and
/// runs on this host, so its rule is checked against the shipped code, not a restatement.
#[cfg(target_vendor = "apple")]
#[test]
fn the_real_apple_bridge_builds_the_listing_url() {
    use nsh_core::prelude::*;
    use nsh_in_app_review::{NativeInAppReview, NativeStoreListingOptions};

    let native = Instance::new(NativeInAppReview::new());
    let blank = |app_store_id: Option<&str>| NativeStoreListingOptions {
        app_store_id: app_store_id.map(str::to_owned),
        microsoft_store_id: None,
    };

    // No id, or a blank one, never builds a URL.
    let missing = run(NativeInAppReview::open_store_listing(native.clone(), None)).unwrap_err();
    assert_eq!(missing.code(), Some("ERR_IN_APP_REVIEW_INVALID_ARGUMENT"));
    let whitespace = run(NativeInAppReview::open_store_listing(
        native.clone(),
        Some(blank(Some("   "))),
    ))
    .unwrap_err();
    assert_eq!(
        whitespace.code(),
        Some("ERR_IN_APP_REVIEW_INVALID_ARGUMENT")
    );

    // A valid id passes the bridge to opening. No engine runs in a test, so the host opener
    // panics on entry — that panic, not an `InvalidArgument`, is the proof the URL was built and
    // the call moved on to opening it.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let reached_opener = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run(NativeInAppReview::open_store_listing(
            native.clone(),
            Some(blank(Some("123456789"))),
        ))
    }))
    .is_err();
    std::panic::set_hook(previous);
    assert!(reached_opener, "a valid id must get past the bridge");
}
