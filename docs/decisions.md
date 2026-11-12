# Decisions

## Open

None.

## Decided

1. **NSH version: 0.5.0.** The crate started on 0.4.0, the version biometrics pinned, and moved to 0.5.0 with the SuperNSH set on 2026-11-11. The crate's API is checked against the released 0.5.0 crate, not against nsh's `main` branch.
2. **Library choice.** StoreKit `SKStoreReviewController` on Apple (iOS and macOS, via objc2-store-kit); Google Play In-App Review API over JNI on Android (jni + ndk-context, following the nsh-biometrics bridge); the host's `openUrl` everywhere else. Nothing else is pulled in.
3. **Platforms in scope for the first release.** iOS, Android, macOS via the Apple bridge; Windows store fallback; Linux no-store fallback; web store-listing only.
4. **Reference repos.** All four cloned cleanly (no relocations needed) into `.refs/` as read-only build material: `in_app_review` from https://github.com/britannio/in_app_review, `react-native-in-app-review` from https://github.com/MinaSamir11/react-native-in-app-review, `nsh` from https://github.com/longbridge/nsh, and `biometrics` from https://github.com/SuperNSH/biometrics.
