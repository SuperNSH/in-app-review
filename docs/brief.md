# In-app review: brief

Request the native in-app review prompt on iOS and Android, with a store fallback.

## Options

- StoreKit SKStoreReviewController: iOS, native
- Google Play In-App Review API: Android, native
- Reference only: in_app_review (Flutter), react-native-in-app-review

## Recommended path

Native bridge on iOS and Android. Desktop opens the store listing through openUrl instead.

## Edge cases to design for

- iOS shows the prompt at most 3 times per 365 days; count client-side
- Android quota is set by Google Play and is not public
- The prompt may show nothing, and the API gives no signal that it was shown
- Do not call it from a button press that the user expects to do something

## Research status

Research done 2026-11-09 by web search. Versions and licences are unverified until checked on the registry before pinning. Full catalogue: the research notes for the SuperNSH library set.
