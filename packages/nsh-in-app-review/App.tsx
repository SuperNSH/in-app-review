import { mount, signal, Text, View } from "nsh";
import { asInAppReviewError, InAppReview } from "./src";

/** The device's own review flow, through the Rust crate. */
const review = new InAppReview();

const availability = signal("checking");
const message = signal("nothing yet");

function App() {
  review.isAvailable().then(
    (available) => availability.set(available ? "review flow available" : "no review flow on this platform"),
    (error: unknown) => availability.set(`availability failed ${asInAppReviewError(error).code}`),
  );
  // The OS decides whether to show anything; the button only asks, and the quota counts the ask.
  const request = () => {
    review.requestReview().then(
      (ran) => {
        // `true` is "the flow ran to its end", never "the OS showed something".
        message.set(
          ran
            ? "the flow ran to its end; the OS may still have shown nothing"
            : "the quota refused; no request was made",
        );
      },
      (error: unknown) => message.set(asInAppReviewError(error).code),
    );
  };
  return (
    <View class="flex-1 gap-3 p-4">
      <Text testID="title" class="text-foreground">nsh-in-app-review</Text>
      <Text testID="availability" class="text-foreground">{availability()}</Text>
      <Text testID="message" class="text-foreground">{message()}</Text>
      <Text testID="request" role="button" onPress={request} class="rounded-(--radius) bg-muted px-3 py-2">
        Ask for a review (the OS may show nothing)
      </Text>
    </View>
  );
}

mount(App);
