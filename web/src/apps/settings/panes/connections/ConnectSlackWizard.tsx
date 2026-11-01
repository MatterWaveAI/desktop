import { useId, useState, type FormEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Alert } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import { CopyButton } from "../../../../components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog";
import { Input } from "../../../../components/ui/input";
import {
  activateSlackConnection,
  createPendingSlackConnection,
  credentialsFailure,
  fetchSlackManifest,
  fieldErrors,
  messageOf,
  type Connection,
  type SlackManifest,
} from "./connectionsApi";

/**
 * Connect Slack, in three steps, each one API call:
 *
 * 1. A pending connection is created so its Request URL exists before the
 *    Slack app does, and the manifest carrying that URL is shown, with a
 *    link to Slack's create-from-manifest page and a Copy. If the API
 *    says Slack cannot reach the ingress host, the step says so first.
 * 2. The bot token and the signing secret the installed app shows are
 *    pasted and checked with Slack (`auth.test`); a refusal is shown in
 *    the adapter's plain words -- wrong token, revoked, another workspace.
 * 3. The connected workspace, and on to its routing.
 *
 * Closing early keeps the pending row in the list, where Remove is.
 */

type Step =
  | { phase: "name" }
  | { phase: "manifest"; connection: Connection; manifest: SlackManifest }
  | { phase: "credentials"; connection: Connection }
  | { phase: "done"; connection: Connection };

export function ConnectSlackWizard(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (connection: Connection) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogContent data-connect-slack-dialog="" className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        {/* Mounted per opening: a second wizard starts at the name, not at the last one's step. */}
        {props.open && (
          <WizardSteps
            busy={busy}
            setBusy={setBusy}
            onCancel={() => props.onOpenChange(false)}
            onConnected={props.onConnected}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WizardSteps(props: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCancel: () => void;
  onConnected: (connection: Connection) => void;
}) {
  const { t } = useLingui();
  const { busy, setBusy } = props;
  const [step, setStep] = useState<Step>({ phase: "name" });
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const tokenId = useId();
  const secretId = useId();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const connection = await createPendingSlackConnection(name.trim());
      const manifest = await fetchSlackManifest(connection.id);
      setStep({ phase: "manifest", connection, manifest });
    } catch (err) {
      setError(fieldErrors(err).display_name ?? messageOf(err, t`Could not start the connection.`));
    } finally {
      setBusy(false);
    }
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.phase !== "credentials" || busy) return;
    const token = botToken.trim();
    const secret = signingSecret.trim();
    if (token === "" || secret === "") return;
    setBusy(true);
    setError(null);
    try {
      const connection = await activateSlackConnection(step.connection.id, {
        bot_token: token,
        signing_secret: secret,
      });
      setStep({ phase: "done", connection });
    } catch (err) {
      setError(credentialsFailure(err, t`Slack could not confirm these credentials.`));
    } finally {
      setBusy(false);
    }
  }

  const failure = error && (
    <p role="alert" className="text-sm text-mw-danger">
      {error}
    </p>
  );

  if (step.phase === "name") {
    return (
      <form noValidate aria-busy={busy} onSubmit={(e) => void create(e)} className="flex flex-col gap-3" data-wizard-step="name">
        <DialogHeader>
          <DialogTitle>
            <Trans>Connect Slack</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              A Slack app of your own is created from a manifest MatterWave writes, installed in your
              workspace, and its token and signing secret pasted back here. Three steps; nothing is
              answered until a channel is routed.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-sm text-mw-text-muted">
            <Trans>Workspace name</Trans>
          </label>
          <Input
            id={nameId}
            name="display_name"
            maxLength={120}
            placeholder={t`e.g. Acme Slack`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-xs text-mw-text-muted">
            <Trans>How this connection is listed here.</Trans>
          </p>
        </div>
        {failure}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={name.trim() === "" || busy}>
            {busy ? t`Starting…` : t`Continue`}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  if (step.phase === "manifest") {
    const manifestJson = JSON.stringify(step.manifest.manifest, null, 2);
    const requestUrl = step.manifest.request_url;
    return (
      <div className="flex flex-col gap-3" data-wizard-step="manifest">
        <DialogHeader>
          <DialogTitle>
            <Trans>Step 1 of 3: create the app in Slack</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The manifest carries this connection&apos;s Request URL. Create the app from it, install the
              app to the workspace, then come back for step 2.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        {!step.manifest.publicly_reachable && (
          <Alert variant="warning" data-wizard-ingress-private="" title={t`Slack cannot reach this deployment`}>
            <Trans>
              The Request URL <span className="font-mono break-all">{requestUrl}</span> is not on a public host, so
              Slack will not be able to deliver events to it. The app can be created, but nothing will be
              answered until this deployment is reachable from the internet.
            </Trans>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={step.manifest.create_url}
            target="_blank"
            rel="noreferrer"
            data-wizard-create-app=""
            className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            <Trans>Create the app in Slack</Trans>
          </a>
          <CopyButton text={manifestJson} label={t`Copy manifest`} size="default" />
        </div>
        <pre
          data-testid="slack-manifest"
          className="max-h-64 overflow-auto rounded-lg border border-border bg-mw-surface-hover p-3 font-mono text-xs"
        >
          {manifestJson}
        </pre>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onCancel}>
            <Trans>Finish later</Trans>
          </Button>
          <Button type="button" onClick={() => setStep({ phase: "credentials", connection: step.connection })}>
            <Trans>The app is installed</Trans>
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (step.phase === "credentials") {
    return (
      <form noValidate aria-busy={busy} onSubmit={(e) => void activate(e)} className="flex flex-col gap-3" data-wizard-step="credentials">
        <DialogHeader>
          <DialogTitle>
            <Trans>Step 2 of 3: paste the app&apos;s credentials</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The bot token is under OAuth &amp; Permissions once the app is installed; the signing secret
              is under Basic Information. Both are checked with Slack and kept encrypted.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={tokenId} className="text-sm text-mw-text-muted">
            <Trans>Bot token</Trans>
          </label>
          <Input
            id={tokenId}
            name="bot_token"
            type="password"
            autoComplete="off"
            placeholder="xoxb-…"
            value={botToken}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={secretId} className="text-sm text-mw-text-muted">
            <Trans>Signing secret</Trans>
          </label>
          <Input
            id={secretId}
            name="signing_secret"
            type="password"
            autoComplete="off"
            value={signingSecret}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setSigningSecret(e.target.value)}
          />
        </div>
        {failure}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
            <Trans>Finish later</Trans>
          </Button>
          <Button type="submit" disabled={botToken.trim() === "" || signingSecret.trim() === "" || busy}>
            {busy ? t`Checking with Slack…` : t`Connect`}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  const workspaceName = step.connection.display_name;
  const workspaceId = step.connection.external_workspace_id ?? "";
  return (
    <div className="flex flex-col gap-3" data-wizard-step="done">
      <DialogHeader>
        <DialogTitle>
          <Trans>Step 3 of 3: connected</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            {workspaceName} is connected
            {workspaceId ? <> (<span className="font-mono">{workspaceId}</span>)</> : null}. Nothing is answered
            yet: route a channel to a preset and a paying member next.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" onClick={() => props.onConnected(step.connection)}>
          <Trans>Continue to routing</Trans>
        </Button>
      </DialogFooter>
    </div>
  );
}
