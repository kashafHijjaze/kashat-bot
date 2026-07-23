import React, { useState, useEffect } from 'react';
import { User } from './types';
import LandingPage from './components/LandingPage';
import Dashboard from './components/Dashboard';
import AdminPanel from './components/AdminPanel';
import AuthModal from './components/AuthModal';
import AdminNotifications from './components/AdminNotifications';
import { Shield, ShieldAlert, LogIn, LogOut, ExternalLink, Bot, Sun, Moon, User as UserIcon, Smartphone, LayoutDashboard } from 'lucide-react';

export default function App() {
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [activeView, setActiveView] = useState<'dashboard' | 'pairing' | 'admin'>('dashboard');
  
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const cached = localStorage.getItem('hijjaze_theme');
    return (cached === 'light' || cached === 'dark') ? cached : 'dark';
  });

  // Load stored login tokens on mount
  useEffect(() => {
    const storedToken = localStorage.getItem('hijjaze_auth_token');
    const storedUser = localStorage.getItem('hijjaze_auth_user');

    if (storedToken && storedUser) {
      try {
        setAuthToken(storedToken);
        const parsedUser = JSON.parse(storedUser);
        setCurrentUser(parsedUser);
        if (parsedUser.role === 'admin') {
          setActiveView('admin');
        } else {
          setActiveView('dashboard');
        }
      } catch (e) {
        localStorage.removeItem('hijjaze_auth_token');
        localStorage.removeItem('hijjaze_auth_user');
      }
    }
  }, []);

  const handleAuthSuccess = (token: string, user: User) => {
    // Save to localStorage for persistence across reloads
    localStorage.setItem('hijjaze_auth_token', token);
    localStorage.setItem('hijjaze_auth_user', JSON.stringify(user));
    setAuthToken(token);
    setCurrentUser(user);
    setShowAuthModal(false);
    if (user.role === 'admin') {
      setActiveView('admin');
    } else {
      setActiveView('dashboard');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('hijjaze_auth_token');
    localStorage.removeItem('hijjaze_auth_user');
    setAuthToken(null);
    setCurrentUser(null);
    setActiveView('pairing');
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('hijjaze_theme', nextTheme);
  };

  const isAdmin = currentUser?.role === 'admin';

  // Theme-dependent colors for core frame
  const frameBg = theme === 'dark' ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900';
  const headerBg = theme === 'dark' ? 'bg-zinc-950/90 border-zinc-900/80 text-zinc-100' : 'bg-white/90 border-zinc-200 text-zinc-800';
  const mainBg = theme === 'dark' ? 'from-zinc-950 to-zinc-900/40' : 'from-white to-zinc-100/50';
  const footerBg = theme === 'dark' ? 'bg-zinc-950/80 border-zinc-900/50 text-zinc-500' : 'bg-white border-zinc-200 text-zinc-500';

  return (
    <div className={`min-h-screen ${frameBg} flex flex-col justify-between font-sans selection:bg-emerald-500/20 selection:text-emerald-400 transition-colors duration-200`}>
      
      {/* Top Floating Navigation Header */}
      <header className={`${headerBg} backdrop-blur-md border-b sticky top-0 z-40 transition-colors duration-200`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          
          {/* Logo & View Navigation Switcher */}
          <div className="flex items-center gap-6">
            <div 
              onClick={() => setActiveView(currentUser ? (isAdmin ? 'admin' : 'dashboard') : 'pairing')}
              className="flex items-center gap-2.5 cursor-pointer select-none group"
            >
              <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20 shadow-sm group-hover:scale-105 transition-transform">
                <Bot className="w-5 h-5" />
              </div>
              <span className="font-extrabold text-lg tracking-tight">Hijjaze <span className="text-emerald-500">Bot</span></span>
            </div>

            {/* Navigation Tabs for Authenticated Users */}
            {currentUser && (
              <nav className="hidden md:flex items-center gap-1 p-1 bg-zinc-900/50 border border-zinc-800/80 rounded-xl">
                {isAdmin && (
                  <button
                    onClick={() => setActiveView('admin')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      activeView === 'admin'
                        ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Shield className="w-3.5 h-3.5" />
                    Admin Console
                  </button>
                )}

                <button
                  onClick={() => setActiveView('dashboard')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    activeView === 'dashboard'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <LayoutDashboard className="w-3.5 h-3.5" />
                  My Profile & Stats
                </button>

                <button
                  onClick={() => setActiveView('pairing')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    activeView === 'pairing'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  Pairing Gateway
                </button>
              </nav>
            )}
          </div>

          {/* Right Header User Controls & Logout Button */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Admin Notifications Bell & Panel */}
            {isAdmin && authToken && (
              <AdminNotifications 
                authToken={authToken} 
                theme={theme} 
                onNavigateTab={() => setActiveView('admin')}
              />
            )}

            {/* Dark / Light Theme Toggle Switch */}
            <button
              onClick={toggleTheme}
              className={`p-2.5 rounded-xl border transition-all shadow-sm ${
                theme === 'dark' 
                  ? 'bg-zinc-900 hover:bg-zinc-850 border-zinc-850 hover:border-zinc-800 text-amber-400' 
                  : 'bg-zinc-100 hover:bg-zinc-200 border-zinc-250 hover:border-zinc-300 text-indigo-600'
              }`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 animate-pulse" /> : <Moon className="w-4 h-4" />}
            </button>

            {currentUser ? (
              <div className="flex items-center gap-3">
                {/* User Profile Badge */}
                <button
                  onClick={() => setActiveView('dashboard')}
                  className="flex items-center gap-2.5 p-1.5 pr-3 bg-zinc-900/60 hover:bg-zinc-850 border border-zinc-800/80 hover:border-zinc-700 rounded-xl transition-all"
                  title="View Profile Details"
                >
                  {currentUser.avatarUrl ? (
                    <img src={currentUser.avatarUrl} alt="Avatar" className="w-7 h-7 rounded-lg object-cover border border-emerald-500/30" />
                  ) : (
                    <div className="w-7 h-7 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg flex items-center justify-center font-black text-xs uppercase">
                      {currentUser.name.charAt(0)}
                    </div>
                  )}
                  <div className="text-left hidden sm:block">
                    <span className="text-xs font-bold text-zinc-200 block leading-tight">{currentUser.name}</span>
                    <span className="text-[10px] text-zinc-500 font-mono block leading-tight">{currentUser.email}</span>
                  </div>
                </button>

                {/* Direct Logout Button */}
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-1.5 px-3 py-2 bg-zinc-900 hover:bg-red-500/10 text-zinc-400 hover:text-red-400 text-xs font-bold rounded-xl border border-zinc-800 hover:border-red-500/20 transition-all active:scale-95 shadow-sm"
                  title="Sign Out of Application"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Logout</span>
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className={`inline-flex items-center gap-2 px-4 py-2 ${
                  theme === 'dark' 
                    ? 'bg-zinc-900 hover:bg-zinc-850 border-zinc-850 hover:border-zinc-800 text-zinc-300 hover:text-zinc-100' 
                    : 'bg-zinc-150 hover:bg-zinc-200 border-zinc-250 hover:border-zinc-300 text-zinc-700 hover:text-zinc-900'
                } text-xs font-bold rounded-xl border transition-all shadow-md`}
              >
                <LogIn className="w-4 h-4" />
                Sign In / Sign Up
              </button>
            )}
          </div>
        </div>

        {/* Mobile Navigation Bar for Authenticated Users */}
        {currentUser && (
          <div className="md:hidden flex items-center justify-around border-t border-zinc-900 px-4 py-2 bg-zinc-950/90 text-xs font-bold">
            {isAdmin && (
              <button
                onClick={() => setActiveView('admin')}
                className={`py-1.5 px-3 rounded-lg ${activeView === 'admin' ? 'bg-red-500/20 text-red-400' : 'text-zinc-400'}`}
              >
                Admin
              </button>
            )}
            <button
              onClick={() => setActiveView('dashboard')}
              className={`py-1.5 px-3 rounded-lg ${activeView === 'dashboard' ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-400'}`}
            >
              My Profile
            </button>
            <button
              onClick={() => setActiveView('pairing')}
              className={`py-1.5 px-3 rounded-lg ${activeView === 'pairing' ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-400'}`}
            >
              Pairing Gateway
            </button>
          </div>
        )}
      </header>

      {/* Main Dynamic Viewport */}
      <main className={`flex-1 bg-gradient-to-b ${mainBg} relative transition-colors duration-200`}>
        {activeView === 'admin' && isAdmin && (
          <AdminPanel 
            currentUser={currentUser} 
            authToken={authToken!} 
            onLogout={handleLogout} 
          />
        )}

        {activeView === 'dashboard' && currentUser && authToken && (
          <Dashboard 
            currentUser={currentUser} 
            authToken={authToken} 
            onLogout={handleLogout} 
            theme={theme}
          />
        )}

        {(activeView === 'pairing' || !currentUser) && (
          <LandingPage 
            onLoginClick={() => setShowAuthModal(true)} 
            currentUser={currentUser}
            authToken={authToken}
            onLogout={handleLogout}
          />
        )}
      </main>

      {/* Auth Modal Overlay */}
      {showAuthModal && (
        <AuthModal 
          onSuccess={handleAuthSuccess} 
          onClose={() => setShowAuthModal(false)} 
        />
      )}

      {/* Footer Navigation */}
      <footer className={`${footerBg} border-t py-6 px-4 transition-colors duration-200`}>
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-zinc-400">Hijjaze Bot v1.0.0</span>
            <span>•</span>
            <span>Production Ready WhatsApp Pairing Gateway</span>
          </div>
          <div className="flex items-center gap-4">
            <a 
              href="https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="hover:text-zinc-300 transition-colors flex items-center gap-1 font-semibold"
            >
              Master Channel
              <ExternalLink className="w-3 h-3" />
            </a>
            <span>•</span>
            <span>Privacy Secure Endpoints</span>
          </div>
        </div>
      </footer>

    </div>
  );
}

