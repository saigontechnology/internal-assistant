import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-16 items-center px-5">
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
          <div className="flex flex-col items-center text-center">
            <img
              src={logoUrl}
              alt="Internal Assistant"
              className="h-8 w-auto shrink-0"
            />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">
              Internal Assistant
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Sign in with your Microsoft account to continue.
            </p>
          </div>

          {error && (
            <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
                <Loader2 className="size-4 animate-spin" />
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
      </main>
    </div>
  );
}
