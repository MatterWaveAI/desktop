import { useState, type ReactNode } from "react";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
import { PageHeader, EmptyState, ErrorState, LoadingSkeleton, DestructiveConfirm } from "../patterns";
import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { Badge, StatusDot } from "../components/ui/badge";
import { Alert, Meter } from "../components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { NavItem } from "../components/ui/nav-item";
import { SearchInput } from "../components/ui/search-input";
import { AssistantMark, BrandLockup } from "../components/brand";
import { SEMANTIC_TOKENS } from "./semanticTokens";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { ScrollArea, ScrollBar } from "../components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SimpleSelect,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Toaster, toast } from "../components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";

/**
 * The design system on one page: every token and every
 * component, rendered in both themes side by side — the `mw-theme-light` /
 * `mw-theme-dark` wrappers re-scope the semantic layer per panel, so drift
 * between themes is visible in review without touching the theme toggle.
 * Registered behind the `dev_tokens` flag; reachable at /dev/tokens.
 */

const RAMPS: { name: string; steps: string[] }[] = [
  {
    name: "neutral",
    steps: ["0", "50", "75", "100", "150", "200", "300", "350", "400", "500", "550", "600", "700", "750", "800", "825", "850", "900", "925", "950"],
  },
  {
    name: "brand",
    steps: ["50", "100", "200", "300", "400", "500", "600", "650", "700", "800", "850", "875", "900", "925", "930"],
  },
  { name: "sky", steps: ["400"] },
  { name: "emerald", steps: ["50", "200", "300", "400", "500", "600", "700", "800", "900", "logo"] },
  { name: "danger", steps: ["50", "200", "300", "400", "500", "600", "700", "850", "950"] },
  { name: "warning", steps: ["50", "200", "300", "350", "400", "600", "700", "800", "850", "900", "950"] },
];


// Literal class strings so the Tailwind scanner sees every utility; a
// template like `text-${step}` would generate nothing at build time.
const TYPE_SCALE: { step: string; className: string }[] = [
  { step: "xs", className: "text-xs" },
  { step: "sm", className: "text-sm" },
  { step: "base", className: "text-base" },
  { step: "lg", className: "text-lg" },
  { step: "xl", className: "text-xl" },
  { step: "2xl", className: "text-2xl" },
  { step: "3xl", className: "text-3xl" },
];
const DISPLAY_SCALE: { step: string; className: string }[] = [
  { step: "display-sm", className: "text-display-sm" },
  { step: "display-md", className: "text-display-md" },
  { step: "display-lg", className: "text-display-lg" },
];
const RADII: { name: string; className: string }[] = [
  { name: "sm", className: "rounded-sm" },
  { name: "md", className: "rounded-md" },
  { name: "lg", className: "rounded-lg" },
  { name: "xl", className: "rounded-xl" },
  { name: "2xl", className: "rounded-2xl" },
  { name: "3xl", className: "rounded-3xl" },
];
const SHADOWS: { name: string; className: string }[] = [
  { name: "sm", className: "shadow-sm" },
  { name: "md", className: "shadow-md" },
  { name: "lg", className: "shadow-lg" },
];

export function TokensPage() {
  return (
    <TooltipProvider>
      <div className="h-full overflow-y-auto bg-mw-surface text-mw-text">
        <div className="mx-auto max-w-6xl px-4 pb-16">
          <PageHeader
            title="Design tokens"
            description="Every token and component in both themes. Primitives never change per theme; the semantic layer does. This page is how drift gets caught in review."
          />

          <Section title="Primitives (theme-independent)">
            <div className="grid gap-3 sm:grid-cols-2">
              {RAMPS.map((ramp) => (
                <div key={ramp.name} className="rounded-lg border border-mw-border p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
                    {ramp.name}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {ramp.steps.map((step) => (
                      <div key={step} className="w-12">
                        <div
                          className="h-8 rounded-md border border-mw-border"
                          style={{ backgroundColor: `var(--color-mw-${ramp.name}-${step})` }}
                        />
                        <p className="mt-1 text-center text-xs text-mw-text-muted">{step}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-mw-border p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
                  Type scale — Inter for the UI, Instrument Serif for display, JetBrains Mono for code
                </p>
                <div className="flex flex-col gap-1">
                  {TYPE_SCALE.map(({ step, className }) => (
                    <p key={step} className={className}>
                      <span className="text-mw-text-muted">text-{step}</span> — Inter
                    </p>
                  ))}
                  {DISPLAY_SCALE.map(({ step, className }) => (
                    <p key={step} className={`font-display ${className}`}>
                      <span className="font-sans text-xs text-mw-text-muted">text-{step}</span> Models that{" "}
                      <em>move</em>
                    </p>
                  ))}
                  <p className="font-mono text-sm">
                    <span className="font-sans text-mw-text-muted">font-mono</span> client.chat.completions.create()
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-3">
                  <p className="text-base font-normal">Weight 400</p>
                  <p className="text-base font-medium">Weight 500</p>
                  <p className="text-base font-semibold">Weight 600</p>
                </div>
              </div>
              <div className="rounded-lg border border-mw-border p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-mw-text-muted">
                  Radii and shadows
                </p>
                <div className="flex flex-wrap gap-2">
                  {RADII.map(({ name, className }) => (
                    <div
                      key={name}
                      className={`flex h-12 w-20 items-center justify-center border border-mw-border text-xs ${className}`}
                    >
                      {name}
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-4">
                  {SHADOWS.map(({ name, className }) => (
                    <div
                      key={name}
                      className={`flex h-12 w-24 items-center justify-center rounded-lg bg-mw-surface-raised text-xs ${className}`}
                    >
                      shadow-{name}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          <Section title="Semantic tokens and components — both themes">
            <div className="flex flex-col gap-4 lg:flex-row">
              <ThemePanel label="Light" themeClass="light" />
              <ThemePanel label="Dark" themeClass="dark" />
            </div>
          </Section>
        </div>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h2 className="mb-3 text-lg font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

function ThemePanel(props: { label: string; themeClass: "light" | "dark" }) {
  const [role, setRole] = useState("member");
  return (
    <section
      aria-label={`${props.label} theme`}
      className={`mw-theme-${props.themeClass} flex-1 rounded-xl border border-mw-border bg-mw-surface p-4 text-mw-text`}
    >
      <h3 className="mb-3 text-base font-semibold">{props.label}</h3>

      <h4 className="mb-2 text-sm font-medium text-mw-text-muted">Semantic tokens</h4>
      <div className="grid gap-1 sm:grid-cols-2">
        {SEMANTIC_TOKENS.map((token) => (
          <div key={token} className="flex items-center gap-2">
            <div
              className="h-8 w-12 shrink-0 rounded-md border border-mw-border"
              style={{ backgroundColor: `var(--mw-color-${token})` }}
            />
            <div className="min-w-0">
              <p className="truncate text-xs">--mw-color-{token}</p>
              <p className="truncate text-xs text-mw-text-muted">bg-mw-{token}</p>
            </div>
          </div>
        ))}
      </div>

      <h4 className="mb-2 mt-5 text-sm font-medium text-mw-text-muted">Buttons</h4>
      <div className="flex flex-wrap items-center gap-2">
        <Button>Default</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="link">Link</Button>
        <Button size="xs">Extra small</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Icon button">
          <PlusIcon />
        </Button>
        <Button disabled>Disabled</Button>
      </div>

      <h4 className="mb-2 mt-5 text-sm font-medium text-mw-text-muted">
        Badges, avatar, skeleton
      </h4>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge variant="positive">
          <StatusDot /> Clean
        </Badge>
        <Badge variant="warning">Degraded</Badge>
        <Badge variant="info">Beta</Badge>
        <Badge variant="outline">Outline</Badge>
        <Avatar>
          <AvatarFallback>MW</AvatarFallback>
        </Avatar>
        <Skeleton className="h-8 w-24" />
      </div>

      <h4 className="mb-2 mt-5 text-sm font-medium text-mw-text-muted">Inputs</h4>
      <div className="flex max-w-sm flex-col gap-2">
        <Input placeholder="Input" aria-label="Input" />
        <SearchInput placeholder="Search" aria-label="Search" />
        <SimpleSelect
          aria-label="Role"
          value={role}
          onValueChange={setRole}
          options={[
            { value: "owner", label: "Owner" },
            { value: "admin", label: "Admin" },
            { value: "member", label: "Member" },
          ]}
        />
        <Select>
          <SelectTrigger>
            <SelectValue placeholder="Select" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default model</SelectItem>
            <SelectItem value="mini">Mini</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <h4 className="mb-2 mt-5 text-sm font-medium text-mw-text-muted">
        Tabs, tooltip, popover, menu, toast, scroll area
      </h4>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
            <TabsTrigger value="two">Two</TabsTrigger>
          </TabsList>
          <TabsContent value="one">First panel</TabsContent>
          <TabsContent value="two">Second panel</TabsContent>
        </Tabs>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline">Tooltip</Button>} />
          <TooltipContent>Tooltip content</TooltipContent>
        </Tooltip>
        <Popover>
          <PopoverTrigger render={<Button variant="outline">Popover</Button>} />
          <PopoverContent>
            <p className="text-sm">Popover content on the token-defined surface.</p>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline">Menu</Button>} />
          <DropdownMenuContent>
            <DropdownMenuItem>First action</DropdownMenuItem>
            <DropdownMenuItem>Second action</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          onClick={() => toast.add({ title: "Toast", description: "From the design tokens page." })}
        >
          Toast
        </Button>
        <ScrollArea className="h-20 w-48 rounded-lg border border-mw-border">
          <ul className="p-2 text-sm">
            <li>ScrollArea item one</li>
            <li>ScrollArea item two</li>
            <li>ScrollArea item three</li>
            <li>ScrollArea item four</li>
            <li>ScrollArea item five</li>
          </ul>
          <ScrollBar />
        </ScrollArea>
      </div>

      <h4 className="mb-2 mt-5 text-sm font-medium text-mw-text-muted">Brand, nav, cards, alerts</h4>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <BrandLockup />
          <AssistantMark />
        </div>
        <nav aria-label={`${props.label} nav sample`} className="flex w-56 flex-col gap-0.5">
          <NavItem href="#members" active>
            Members
          </NavItem>
          <NavItem href="#keys">API keys</NavItem>
        </nav>
        <Card>
          <CardHeader>
            <CardTitle as="h4">2 people</CardTitle>
          </CardHeader>
          <CardContent>A hairline panel on the raised surface.</CardContent>
        </Card>
        <Alert variant="info" title="Info">Something to know.</Alert>
        <Alert variant="success" title="Saved">Your changes are live.</Alert>
        <Alert variant="warning" title="2 of 1 seat in use" action={<Button size="sm">Add seats</Button>}>
          Invites are paused until a seat is free.
          <Meter value={100} tone="warning" className="mt-2" />
        </Alert>
        <Alert variant="danger" title="Payment failed">Update the card on file.</Alert>
      </div>

      <h4 className="mb-2 mt-5 text-sm font-medium text-mw-text-muted">Patterns</h4>
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-mw-border">
          <EmptyState
            icon={<MessageSquareIcon />}
            title="No conversations yet"
            description="Send a message to start."
            action={<Button size="sm">New chat</Button>}
          />
        </div>
        <div className="rounded-lg border border-mw-border">
          <ErrorState
            title="Could not load"
            message="The API may be down."
            retryLabel="Retry"
            onRetry={() => {}}
          />
        </div>
        <div className="rounded-lg border border-mw-border">
          <LoadingSkeleton rows={3} />
        </div>
        <PageHeader
          title="PageHeader"
          description="The top of every full-page surface."
          actions={<Button size="sm">Action</Button>}
        />
        <ConfirmDemo />
      </div>
    </section>
  );
}

function ConfirmDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-mw-border p-4">
      <Button variant="destructive" onClick={() => setOpen(true)}>
        DestructiveConfirm
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={setOpen}
        title="Delete this?"
        description="A destructive confirm from the pattern library."
        confirmLabel="Delete"
        onConfirm={() => setOpen(false)}
      />
    </div>
  );
}
