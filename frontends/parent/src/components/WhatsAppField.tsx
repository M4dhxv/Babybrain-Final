import { SelectField, Opt } from "./SelectField";
import { WHATSAPP_COUNTRIES } from "../lib/validation";

/** Country code (Singapore first and selected by default) plus the number. */
export function WhatsAppField({
  country,
  number,
  onCountry,
  onNumber,
  inputClass,
  id = "su-whatsapp",
}: {
  country: string;
  number: string;
  onCountry: (code: string) => void;
  onNumber: (value: string) => void;
  inputClass: string;
  id?: string;
}) {
  const dial = WHATSAPP_COUNTRIES.find((c) => c.code === country)?.dial ?? "65";
  return (
    <div>
      <label className="mb-1 block text-sm font-black" htmlFor={id}>WhatsApp number</label>
      <div className="flex gap-2">
        <SelectField
          value={country}
          onChange={onCountry}
          aria-label="Country code"
          className="!h-12 !w-[132px] shrink-0 !rounded-[12px] !border-[#FED7E4] !bg-white !px-3 !text-base !font-semibold"
        >
          {WHATSAPP_COUNTRIES.map((c) => (
            <Opt key={c.code} value={c.code}>{`${c.code} +${c.dial}`}</Opt>
          ))}
        </SelectField>
        <input
          id={id}
          className={`${inputClass} min-w-0 flex-1`}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={number}
          onChange={(e) => onNumber(e.target.value)}
          placeholder={country === "SG" ? "9123 4567" : "Number without +" + dial}
        />
      </div>
      <p className="mt-1.5 text-xs font-semibold text-[#6D748D]">
        We use WhatsApp to send you booking confirmations and reminders.
      </p>
    </div>
  );
}
