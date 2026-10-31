import { MessageAction } from "./BranchControls";

/**
 * Read aloud, under a stored reply: the speaker button that hands the
 * reply's text to the webview's speechSynthesis (tts.ts, useReadAloud).
 * While it is the one reading, the same button is the stop button -- one
 * control, the state in its label, like Copy/Copied.
 */
export function ReadAloudAction(props: {
  speaking: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <MessageAction
      label={props.speaking ? "Stop reading" : "Read aloud"}
      onClick={() => props.onToggle()}
      disabled={props.disabled}
    />
  );
}
