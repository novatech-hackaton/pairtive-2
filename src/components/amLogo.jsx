export function AmLogo({ className = '', withText = true }) {
  const src = withText ? '/pairtivelogo.png' : '/mainlogo.png';
  const size = withText ? 'h-10 w-auto max-w-[13rem]' : 'size-9';

  return (
    <span className={`inline-flex items-center ${className}`}>
      <img
        src={src}
        alt="Pairtive"
        className={`${size} object-contain drop-shadow-[0_6px_18px_rgba(99,102,241,0.55)]`}
        draggable="false"
      />
    </span>
  );
}

export function AmSpinner({ label = 'Loading', className = '' }) {
  return (
    <span role="status" className={`inline-flex items-center gap-3 text-slate-400 ${className}`}>
      <span className="relative size-6" aria-hidden>
        <span className="absolute inset-0 rounded-full border-2 border-white/10" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-cyan border-r-brand-violet" />
      </span>
      <span className="text-sm">{label}</span>
    </span>
  );
}

export function AmFullScreenLoader({ label = 'Loading Pairtive' }) {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-6">
        <AmLogo />
        <AmSpinner label={label} />
      </div>
    </div>
  );
}
