import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Compass, House, LogOut, MessageCircle, Sparkles, UserRound } from 'lucide-react';
import { AmLogo } from './amLogo.jsx';
import { AmAvatar } from './amAvatar.jsx';
import { AmButton } from './amButton.jsx';

const AM_NAV = [
  { to: '/home', label: 'Home', icon: House },
  { to: '/skillgps', label: 'SkillGPS', icon: Compass },
  { to: '/match', label: 'Find match', icon: Sparkles },
  { to: '/messages', label: 'Messages', icon: MessageCircle },
  { to: '/profile', label: 'Profile', icon: UserRound },
];

/**
 * App shell: top bar on desktop, bottom tab bar on mobile.
 * `profile`/`unread`/`onSignOut` are passed in so the shell stays easy to test.
 */
export function AmLayout({ profile, unread = 0, onSignOut, children }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#am-main"
        className="am-sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-ink-700 focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <NavLink to="/home" aria-label="Pairtive home">
            <AmLogo />
          </NavLink>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {AM_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `relative inline-flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition ${
                    isActive ? 'bg-white/8 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white'
                  }`
                }
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
                {item.to === '/messages' && unread > 0 ? (
                  <span className="grid min-w-5 place-items-center rounded-full bg-brand-cyan px-1 text-[0.65rem] font-bold text-ink-950">
                    {unread > 9 ? '9+' : unread}
                    <span className="am-sr-only"> unread</span>
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate('/profile')} className="rounded-full" aria-label="Your profile">
              <AmAvatar name={profile?.name ?? ''} src={profile?.avatar_url} size="sm" />
            </button>
            <AmButton variant="ghost" size="sm" icon={LogOut} onClick={onSignOut} className="hidden sm:inline-flex">
              Sign out
            </AmButton>
          </div>
        </div>
      </header>

      <main id="am-main" className="mx-auto min-h-0 min-w-0 w-full max-w-6xl flex-1 px-4 pt-6 pb-28 sm:px-6 md:pb-12">
        {children ?? <Outlet />}
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-3 bottom-3 z-40 grid grid-cols-5 rounded-3xl glass-strong p-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] shadow-glow md:hidden"
      >
        {AM_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `relative flex flex-col items-center gap-1 rounded-2xl py-2 text-[0.7rem] font-medium transition ${
                isActive ? 'bg-white/10 text-white' : 'text-slate-400'
              }`
            }
          >
            <item.icon className="size-5" aria-hidden />
            {item.label}
            {item.to === '/messages' && unread > 0 ? (
              <span className="absolute top-1 right-[calc(50%-1.25rem)] size-2.5 rounded-full bg-brand-cyan ring-2 ring-ink-900" aria-label={`${unread} unread`} />
            ) : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
