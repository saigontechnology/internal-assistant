import { useEffect, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { useAuth } from "@/lib/auth";
import logoUrl from "@/assets/logo.svg";

function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 23 23" className={className} aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const handleLogin = () => {
    setIsSigningIn(true);
    setError(null);
    login();
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get("auth");
    if (auth === "error" || auth === "deactivated") {
      setError(
        auth === "deactivated"
          ? "This account has been deactivated. Contact an administrator."
          : "Sign-in failed. Please try again.",
      );
      params.delete("auth");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (qs ? `?${qs}` : ""),
      );
    }
  }, []);

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
      {/* Ambient depth: a lime bloom top-right, a navy wash bottom-left. The
          sign-in screen should feel like a lit room, not a blank form. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(48rem_36rem_at_85%_-5%,oklch(0.72_0.18_130/0.1),transparent),radial-gradient(42rem_32rem_at_10%_110%,oklch(0.4_0.06_262/0.12),transparent)]"
      />

      <header className="flex h-16 items-center px-5">
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-border bg-card p-8 shadow-lg">
            <div className="flex flex-col items-center text-center">
              <img
                src={logoUrl}
                alt="Internal Assistant"
                className="h-9 w-auto shrink-0"
              />
              <p className="label-eyebrow mt-6 text-primary">Reading Room</p>
              <h1 className="mt-2 font-heading text-3xl font-medium tracking-tight text-balance">
                Internal Assistant
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-pretty">
                Sign in with your Microsoft account to reach your document room.
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            <Button
              type="button"
              onClick={handleLogin}
              disabled={isSigningIn}
              className="mt-6 w-full gap-2"
              size="lg"
              variant="outline"
            >
              {isSigningIn ? (
                <>
                  <CircleNotch className="size-4 animate-spin" />
                  Redirecting to Microsoft…
                </>
              ) : (
                <>
                  <MicrosoftLogo className="size-4" />
                  Sign in with Microsoft
                </>
              )}
            </Button>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Access is restricted to authorized staff.
          </p>
        </div>
      </main>
    </div>
  );
}
