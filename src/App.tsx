import React, { useState, useEffect } from 'react';
import { User } from './types';
import LandingPage from './components/LandingPage';
import Dashboard from './components/Dashboard';
import AdminPanel from './components/AdminPanel';
import AuthModal from './components/AuthModal';
import { Shield, ShieldAlert, LogIn, ExternalLink, Bot, Sun, Moon } from 'lucide-react';

export default function App() {
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
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
        setCurrentUser(JSON.parse(storedUser));
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
  };

  const handleLogout = () => {
    localStorage.removeItem('hijjaze_auth_token');
    localStorage.removeItem('hijjaze_auth_user');
    setAuthToken(null);
    setCurrentUser(null);
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('hijjaze_theme', nextTheme);
  };

  const isAdmin = currentUser?.role === 'admin';
  const isUser = currentUser?.role === 'user';

  // Theme-dependent colors for core frame
  const frameBg = theme === 'dark' ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-900';
  const headerBg = theme === 'dark' ? 'bg-zinc-950/80 border-zinc-900/60 text-zinc-100' : 'bg-white/85 border-zinc-200 text-zinc-800';
  const mainBg = theme === 'dark' ? 'from-zinc-950 to-zinc-900/40' : 'from-white to-zinc-100/50';
  const footerBg = theme === 'dark' ? 'bg-zinc-950/80 border-zinc-900/50 text-zinc-500' : 'bg-white border-zinc-200 text-zinc-500';

  return (
    <div className={`min-h-screen ${frameBg} flex flex-col justify-between font-sans selection:bg-emerald-500/20 selection:text-emerald-400 transition-colors duration-200`}>
      
      {/* Top Floating Navigation Header */}
      <header className={`${headerBg} backdrop-blur-md border-b sticky top-0 z-40 transition-colors duration-200`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20 shadow-sm">
              <Bot className="w-5 h-5" />
            </div>
            <span className="font-extrabold text-lg tracking-tight">Hijjaze <span className="text-emerald-500">Bot</span></span>
          </div>

          <div className="flex items-center gap-3">
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
              {theme === 'dark' ? <Sun className="w-4.5 h-4.5 animate-pulse" /> : <Moon className="w-4.5 h-4.5" />}
            </button>

            {currentUser ? (
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 text-[10px] font-bold font-mono uppercase rounded border ${
                  isAdmin 
                    ? 'bg-red-500/10 text-red-400 border-red-500/20' 
                    : theme === 'dark' ? 'bg-zinc-900 text-zinc-400 border-zinc-800' : 'bg-zinc-100 text-zinc-500 border-zinc-250'
                }`}>
                  {currentUser.role}
                </span>
                
                {isAdmin && (
                  <div className={`hidden sm:inline-block text-xs font-semibold ${theme === 'dark' ? 'text-zinc-500' : 'text-zinc-400'} font-sans`}>
                    Master Console Enabled
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => setShowAuthModal(true)}
                className={`inline-flex items-center gap-2 px-4 py-2 ${
                  theme === 'dark' 
                    ? 'bg-zinc-900 hover:bg-zinc-850 border-zinc-850 hover:border-zinc-800 text-zinc-300 hover:text-zinc-100' 
                    : 'bg-zinc-150 hover:bg-zinc-200 border-zinc-250 hover:border-zinc-300 text-zinc-700 hover:text-zinc-900'
                } text-sm font-bold rounded-xl border transition-all shadow-md`}
              >
                <LogIn className="w-4 h-4" />
                Sign In / Sign Up
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Dynamic Viewport */}
      <main className={`flex-1 bg-gradient-to-b ${mainBg} relative transition-colors duration-200`}>
        {isAdmin ? (
          /* Render full control admin panel */
          <AdminPanel 
            currentUser={currentUser!} 
            authToken={authToken!} 
            onLogout={handleLogout} 
          />
        ) : (
          /* Render default device linking gateway for general guests and regular users */
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
