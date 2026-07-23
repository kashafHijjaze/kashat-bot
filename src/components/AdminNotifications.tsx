import React, { useState, useEffect, useRef } from 'react';
import { AdminNotification } from '../types';
import { 
  Bell, UserPlus, Unplug, Wifi, ShieldAlert, CheckCheck, Trash2, X, Check,
  Sparkles, ExternalLink, AlertTriangle, ArrowRight, BellRing, Info
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';

interface AdminNotificationsProps {
  authToken: string;
  theme?: 'dark' | 'light';
  onNavigateTab?: (tab: 'users' | 'sessions' | 'logs') => void;
}

export default function AdminNotifications({ authToken, theme = 'dark', onNavigateTab }: AdminNotificationsProps) {
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [toasts, setToasts] = useState<AdminNotification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread' | 'user_register' | 'session_disconnect'>('all');
  const [hasNewAlert, setHasNewAlert] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  // Fetch initial notifications
  const fetchNotifications = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/notifications', {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data);
      }
    } catch (err) {
      console.error('Failed to fetch admin notifications:', err);
    }
  };

  useEffect(() => {
    fetchNotifications();

    // Setup Socket.IO listener for real-time alert push
    const socket = io();
    socketRef.current = socket;

    socket.emit('join', 'admin');
    socket.emit('join-admin');

    socket.on('admin-notification', (notif: AdminNotification) => {
      setNotifications(prev => [notif, ...prev]);
      
      // Trigger toast popup & bell animation
      setToasts(prev => [notif, ...prev.slice(0, 4)]);
      setHasNewAlert(true);

      // Auto-remove toast after 6 seconds
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== notif.id));
      }, 6000);
    });

    return () => {
      socket.disconnect();
    };
  }, [authToken]);

  // Handle clicking outside to close panel
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    } else {
      document.removeEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const handleTogglePanel = () => {
    setIsOpen(!isOpen);
    setHasNewAlert(false);
  };

  const handleMarkAsRead = async (id: string) => {
    try {
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
      await fetch(`/api/admin/notifications/${id}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
    } catch (err) {
      console.error('Failed to mark notification read:', err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      await fetch('/api/admin/notifications/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
    } catch (err) {
      console.error('Failed to mark all read:', err);
    }
  };

  const handleDeleteNotification = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      setNotifications(prev => prev.filter(n => n.id !== id));
      await fetch(`/api/admin/notifications/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
    } catch (err) {
      console.error('Failed to delete notification:', err);
    }
  };

  const handleClearAll = async () => {
    try {
      setNotifications([]);
      await fetch('/api/admin/notifications', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
    } catch (err) {
      console.error('Failed to clear notifications:', err);
    }
  };

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const filteredNotifications = notifications.filter(n => {
    if (filter === 'unread') return !n.read;
    if (filter === 'user_register') return n.type === 'user_register';
    if (filter === 'session_disconnect') return n.type === 'session_disconnect';
    return true;
  });

  const formatTime = (ts: string) => {
    try {
      const date = new Date(ts);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return ts;
    }
  };

  const getNotifIcon = (type: string) => {
    switch (type) {
      case 'user_register':
        return <UserPlus className="w-4 h-4 text-emerald-400" />;
      case 'session_disconnect':
        return <Unplug className="w-4 h-4 text-rose-400" />;
      case 'session_connect':
        return <Wifi className="w-4 h-4 text-emerald-400" />;
      case 'account_status':
        return <ShieldAlert className="w-4 h-4 text-amber-400" />;
      default:
        return <Info className="w-4 h-4 text-sky-400" />;
    }
  };

  const getNotifBadgeBg = (type: string) => {
    switch (type) {
      case 'user_register':
        return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
      case 'session_disconnect':
        return 'bg-rose-500/10 border-rose-500/20 text-rose-400';
      case 'session_connect':
        return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
      case 'account_status':
        return 'bg-amber-500/10 border-amber-500/20 text-amber-400';
      default:
        return 'bg-sky-500/10 border-sky-500/20 text-sky-400';
    }
  };

  return (
    <div className="relative inline-block" ref={panelRef}>
      
      {/* HEADER BELL BUTTON */}
      <button
        onClick={handleTogglePanel}
        className={`relative p-2 rounded-xl border transition-all duration-200 active:scale-95 ${
          isOpen
            ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400 shadow-md shadow-emerald-500/10'
            : theme === 'dark'
            ? 'bg-zinc-900 hover:bg-zinc-850 border-zinc-800 text-zinc-300 hover:text-zinc-100'
            : 'bg-zinc-100 hover:bg-zinc-200 border-zinc-250 text-zinc-700'
        }`}
        title="Admin Notifications Center"
      >
        {hasNewAlert ? (
          <BellRing className="w-4.5 h-4.5 text-emerald-400 animate-bounce" />
        ) : (
          <Bell className="w-4.5 h-4.5" />
        )}

        {/* Unread Counter Badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 text-white font-extrabold text-[10px] rounded-full flex items-center justify-center border-2 border-zinc-950 shadow-sm animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* DROPDOWN NOTIFICATIONS PANEL */}
      {isOpen && (
        <div className="absolute right-0 mt-3 w-80 sm:w-96 max-w-[calc(100vw-2rem)] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl z-50 overflow-hidden backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
          
          {/* Panel Header */}
          <div className="p-4 border-b border-zinc-800/80 bg-zinc-900/60 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg">
                <Bell className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-zinc-100 tracking-tight flex items-center gap-2">
                  Admin Alerts
                  {unreadCount > 0 && (
                    <span className="px-2 py-0.5 bg-red-500/20 text-red-400 border border-red-500/30 text-[10px] font-mono font-bold rounded-full">
                      {unreadCount} Unread
                    </span>
                  )}
                </h3>
                <p className="text-[11px] text-zinc-400 font-sans">Real-time user & WhatsApp session status alerts</p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  className="p-1.5 text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                  title="Mark all as read"
                >
                  <CheckCheck className="w-4 h-4" />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={handleClearAll}
                  className="p-1.5 text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                  title="Clear all notifications"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Filter Pills */}
          <div className="p-2 border-b border-zinc-900 bg-zinc-950/80 flex items-center gap-1 text-[11px] font-bold overflow-x-auto no-scrollbar">
            <button
              onClick={() => setFilter('all')}
              className={`px-2.5 py-1 rounded-lg transition-all whitespace-nowrap ${
                filter === 'all'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              All ({notifications.length})
            </button>
            <button
              onClick={() => setFilter('unread')}
              className={`px-2.5 py-1 rounded-lg transition-all whitespace-nowrap ${
                filter === 'unread'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              Unread ({unreadCount})
            </button>
            <button
              onClick={() => setFilter('user_register')}
              className={`px-2.5 py-1 rounded-lg transition-all whitespace-nowrap flex items-center gap-1 ${
                filter === 'user_register'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <UserPlus className="w-3 h-3" />
              New Users
            </button>
            <button
              onClick={() => setFilter('session_disconnect')}
              className={`px-2.5 py-1 rounded-lg transition-all whitespace-nowrap flex items-center gap-1 ${
                filter === 'session_disconnect'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <Unplug className="w-3 h-3" />
              Disconnects
            </button>
          </div>

          {/* Notifications Scrollable List */}
          <div className="max-h-80 overflow-y-auto divide-y divide-zinc-900/80 p-2 space-y-1">
            {filteredNotifications.length === 0 ? (
              <div className="py-12 text-center text-zinc-500">
                <Bell className="w-8 h-8 mx-auto mb-2 text-zinc-700" />
                <p className="text-xs font-semibold text-zinc-400">No notifications found</p>
                <p className="text-[11px] text-zinc-600">You're all caught up!</p>
              </div>
            ) : (
              filteredNotifications.map(notif => (
                <div
                  key={notif.id}
                  onClick={() => !notif.read && handleMarkAsRead(notif.id)}
                  className={`group relative p-3 rounded-xl border transition-all cursor-pointer flex gap-3 ${
                    !notif.read
                      ? 'bg-zinc-900/80 hover:bg-zinc-850 border-emerald-500/20 shadow-sm'
                      : 'bg-zinc-950/40 hover:bg-zinc-900/60 border-zinc-900 text-zinc-400'
                  }`}
                >
                  {/* Icon Card */}
                  <div className={`p-2 rounded-xl border shrink-0 self-start ${getNotifBadgeBg(notif.type)}`}>
                    {getNotifIcon(notif.type)}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0 pr-4">
                    <div className="flex items-center justify-between gap-1 mb-0.5">
                      <h4 className={`text-xs font-bold truncate ${!notif.read ? 'text-zinc-100' : 'text-zinc-300'}`}>
                        {notif.title}
                      </h4>
                      <span className="text-[10px] text-zinc-500 font-mono shrink-0">
                        {formatTime(notif.timestamp)}
                      </span>
                    </div>

                    <p className="text-xs text-zinc-400 leading-snug line-clamp-2 font-sans mb-1.5">
                      {notif.message}
                    </p>

                    {/* Action Links / Context Badges */}
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      {notif.userEmail && (
                        <span className="px-1.5 py-0.5 bg-zinc-800 text-zinc-300 font-mono rounded border border-zinc-700/60 truncate max-w-[180px]">
                          {notif.userEmail}
                        </span>
                      )}

                      {onNavigateTab && (notif.type === 'user_register' || notif.type === 'session_disconnect') && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (notif.type === 'user_register') onNavigateTab('users');
                            if (notif.type === 'session_disconnect') onNavigateTab('sessions');
                            setIsOpen(false);
                          }}
                          className="text-emerald-400 hover:text-emerald-300 font-bold flex items-center gap-1 transition-colors"
                        >
                          View Details
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Unread Dot */}
                  {!notif.read && (
                    <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50"></span>
                  )}

                  {/* Delete Button on Hover */}
                  <button
                    onClick={(e) => handleDeleteNotification(e, notif.id)}
                    className="absolute bottom-2 right-2 p-1 text-zinc-600 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-all opacity-0 group-hover:opacity-100"
                    title="Delete Notification"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Panel Footer */}
          <div className="p-2.5 border-t border-zinc-800/80 bg-zinc-900/40 text-center">
            <span className="text-[10px] text-zinc-500 font-mono">
              Live updates via Socket.IO • Hijjaze Bot Admin Engine
            </span>
          </div>

        </div>
      )}

      {/* REAL-TIME FLOATING TOAST POPUPS */}
      <div className="fixed top-20 right-4 sm:right-6 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto p-4 rounded-2xl border shadow-2xl backdrop-blur-2xl flex items-start gap-3 animate-in slide-in-from-right-8 duration-300 ${
              toast.type === 'session_disconnect'
                ? 'bg-rose-950/90 border-rose-500/40 text-zinc-100 shadow-rose-950/50'
                : 'bg-zinc-950/95 border-emerald-500/40 text-zinc-100 shadow-emerald-950/50'
            }`}
          >
            <div className={`p-2.5 rounded-xl border shrink-0 ${getNotifBadgeBg(toast.type)}`}>
              {getNotifIcon(toast.type)}
            </div>

            <div className="flex-1 min-w-0 pr-2">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] font-black font-mono uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                  REAL-TIME ALERT
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">Just Now</span>
              </div>
              <h4 className="text-xs font-bold text-zinc-100 truncate mb-0.5">
                {toast.title}
              </h4>
              <p className="text-xs text-zinc-300 leading-snug line-clamp-2">
                {toast.message}
              </p>
            </div>

            <button
              onClick={() => dismissToast(toast.id)}
              className="text-zinc-500 hover:text-zinc-200 p-1 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

    </div>
  );
}
