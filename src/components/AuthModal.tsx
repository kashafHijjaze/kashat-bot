import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { Shield, Mail, Lock, AlertCircle, Chrome, ArrowRight, X, Settings, Check } from 'lucide-react';

interface AuthModalProps {
  onSuccess: (token: string, user: User) => void;
  onClose: () => void;
}

export default function AuthModal({ onSuccess, onClose }: AuthModalProps) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Retrieve client ID purely from environment variables
  const googleClientId = ((import.meta as any).env.VITE_GOOGLE_CLIENT_ID || '').trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
      const body = isRegister 
        ? { email, password, name }
        : { email, password };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      onSuccess(data.token, data.user);
    } catch (err: any) {
      setError(err.message || 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!googleClientId) return;

    const initGoogleSignIn = () => {
      const g = (window as any).google;
      if (g?.accounts?.id) {
        g.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response: any) => {
            setError('');
            setLoading(true);
            try {
              const res = await fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  credential: response.credential,
                  clientId: googleClientId
                })
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.error || 'Google Sign-In failed');
              }
              onSuccess(data.token, data.user);
            } catch (err: any) {
              setError(err.message || 'Google login verification failed');
            } finally {
              setLoading(false);
            }
          }
        });

        const btnElem = document.getElementById('google-signin-button');
        if (btnElem) {
          g.accounts.id.renderButton(btnElem, {
            theme: 'filled_blue',
            size: 'large',
            width: '320',
            text: 'signin_with',
            shape: 'rectangular'
          });
        }
      } else {
        setTimeout(initGoogleSignIn, 200);
      }
    };

    initGoogleSignIn();
  }, [googleClientId, isRegister]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl">
        {/* Decorative ambient gradient */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 bg-emerald-500/10 blur-3xl rounded-full pointer-events-none" />

        <div className="p-6 sm:p-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg">
                <Shield className="w-5 h-5" />
              </div>
              <h2 className="text-xl font-bold text-zinc-100">
                {isRegister ? 'Create Account' : 'Sign In'}
              </h2>
            </div>
            <button 
              onClick={onClose}
              className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg hover:bg-zinc-900"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <p className="text-sm text-zinc-400 mb-6">
            {isRegister 
              ? 'Join Hijjaze Bot to link and manage your custom WhatsApp sessions.' 
              : 'Sign in to access your linked devices and connection history.'}
          </p>

          {/* Google Sign In Section */}
          {googleClientId ? (
            <div className="flex flex-col items-center justify-center gap-3">
              <div id="google-signin-button" className="w-full flex justify-center min-h-[44px]" />
            </div>
          ) : (
            <div className="p-4 bg-zinc-900/60 rounded-xl border border-zinc-800/80 text-center space-y-2">
              <div className="flex items-center justify-center gap-2 text-zinc-400 text-xs font-semibold">
                <Chrome className="w-4 h-4 text-zinc-500" />
                Google Sign-In requires configuration
              </div>
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Please configure your <code className="font-mono text-emerald-400 bg-black px-1 py-0.5 rounded">VITE_GOOGLE_CLIENT_ID</code> in environment variables to enable.
              </p>
            </div>
          )}

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-zinc-800"></div>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="px-2 bg-zinc-950 text-zinc-500">Or email login</span>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3.5 mb-5 bg-red-950/40 border border-red-900/50 rounded-xl text-red-400 text-sm">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isRegister && (
              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-200 placeholder-zinc-600 text-sm transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-zinc-600" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full pl-10 pr-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-200 placeholder-zinc-600 text-sm transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-zinc-600" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-10 pr-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-200 placeholder-zinc-600 text-sm transition-colors"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl transition-all duration-200 mt-2 hover:shadow-lg active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  {isRegister ? 'Register Account' : 'Sign In'}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 text-center text-sm">
            <button
              onClick={() => setIsRegister(!isRegister)}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {isRegister ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
