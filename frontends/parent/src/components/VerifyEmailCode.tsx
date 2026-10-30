import { useState } from "react";
import { Button } from "./ui";
import { useAuth } from "../auth/AuthProvider";
import { ResendConfirmation } from "./ResendConfirmation";

/** "Enter the code we emailed you" — confirms a new account in this tab, so a
 *  parent who signed up in the installed app stays in it rather than being sent
 *  to whichever browser their mail app opens the link in. The email keeps its
 *  link as well, so tapping that still works.
 *
 *  `onVerified` runs once the code is accepted and the parent is signed in;
 *  the button stays busy until it settles, since it usually navigates away. */
export function VerifyEmailCode({
  email,
  title = "Check your email",
  startCoolingDown = false,
  onVerified,
  onChangeEmail,
}: {
  email: string;
  title?: React.ReactNode;
  /** True straight after sign-up, when the email has only just been sent. */
  startCoolingDown?: boolean;
  onVerified: () => Promise<void> | void;
  onChangeEmail?: () => void;
}) {
  const { verifySignupCode } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length < 6) {
      setError("Enter the full code from the email.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: problem } = await verifySignupCode(email, code);
    if (problem) {
      setBusy(false);
      setError(problem);
      return;
    }
    try {
      await onVerified();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-center">
      <h1 className="text-2xl font-black">{title}</h1>
      <p className="mt-3 font-semibold text-[#44507b]">
        We sent a confirmation code to<strong className="break-words">{email}</strong>. Enter it below, or tap the link in the email.
      </p>

      <form onSubmit={submit} noValidate className="mx-auto mt-6 max-w-[320px]">
        <label htmlFor="verify-code" className="sr-only">Confirmation code</label>
        <input
          id="verify-code"
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          enterKeyHint="go"
          // Supabase's code length is a project setting (6 to 8 digits), so
          // don't hint at a length; accept up to 8.
          maxLength={8}
          value={code}
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, "")); setError(null); }}
          placeholder="Enter code"
          className="h-14 w-full rounded-[12px] border border-[#FED7E4] bg-white px-4 text-center text-2xl font-black tracking-[0.4em] placeholder:text-base placeholder:font-semibold placeholder:tracking-normal placeholder:text-[#B8AEB3]"
        />
        {error && (
          <p role="alert" className="mt-3 rounded-[10px] border border-[#FED7E4] bg-[#FEEBF2] px-4 py-3 text-sm font-bold text-baby-cta">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="mt-4 w-full justify-center" disabled={busy}>
          {busy ? "Checking…" : "Confirm"}
        </Button>
      </form>

      <p className="mt-5 text-sm font-semibold text-[#6D748D]">Can't find it? Check your spam or promotions folder. It can take a couple of minutes.</p>
      <ResendConfirmation email={email} startCoolingDown={startCoolingDown} />
      {onChangeEmail && (
        <p className="mt-3 text-sm font-semibold text-[#5a6690]">
          Wrong address?{" "}
          <button type="button" onClick={onChangeEmail} className="font-black text-baby-pink underline">
            Go back and fix it
          </button>
        </p>
      )}
      <p className="mt-2 text-sm font-semibold text-[#5a6690]">
        Still nothing? Email <a href="mailto:hello@babybrain.sg" className="font-black text-baby-pink underline">hello@babybrain.sg</a> and we'll activate your account.
      </p>
    </div>
  );
}
