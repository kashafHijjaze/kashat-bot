import React, { useState } from 'react';
import { MessageSquare, Send, CheckCircle2, AlertCircle } from 'lucide-react';

interface BotControlProps {
  authToken: string;
  isConnected: boolean;
}

export default function BotControl({ authToken, isConnected }: BotControlProps) {
  const [targetPhone, setTargetPhone] = useState('');
  const [messageType, setMessageType] = useState('text');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) return;
    setError('');
    setSuccess(false);
    setSending(true);

    try {
      const response = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          targetPhone,
          messageType,
          content,
          fileName: messageType === 'document' || messageType === 'image' ? fileName || undefined : undefined
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send message');
      }

      setSuccess(true);
      setContent('');
      setFileName('');
    } catch (err: any) {
      setError(err.message || 'Error occurred while sending message');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`bg-zinc-950 border border-zinc-900 rounded-2xl p-6 space-y-6 ${!isConnected ? 'opacity-50 pointer-events-none relative' : ''}`}>
      {!isConnected && (
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px] rounded-2xl z-10 flex items-center justify-center">
          <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl flex items-center gap-2.5 shadow-xl text-zinc-400 text-sm">
            <AlertCircle className="w-5 h-5 text-zinc-500 shrink-0" />
            Connect WhatsApp to enable the test messaging terminal
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg">
          <MessageSquare className="w-5 h-5" />
        </div>
        <div className="space-y-0.5">
          <h3 className="text-lg font-bold text-zinc-100">WhatsApp Test Terminal</h3>
          <p className="text-xs text-zinc-500 font-sans">Send custom text payloads, images, or media tests via your connected session.</p>
        </div>
      </div>

      {success && (
        <div className="flex items-center gap-2 p-3 bg-emerald-950/20 border border-emerald-900/40 rounded-xl text-emerald-400 text-sm">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>Message successfully sent to {targetPhone}!</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-950/20 border border-red-900/40 rounded-xl text-red-400 text-sm">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSendMessage} className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Recipient Phone Number</label>
            <input
              type="tel"
              required
              disabled={!isConnected}
              value={targetPhone}
              onChange={(e) => setTargetPhone(e.target.value)}
              placeholder="e.g. 923001234567"
              className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-200 placeholder-zinc-600 text-sm transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Message Format</label>
            <select
              disabled={!isConnected}
              value={messageType}
              onChange={(e) => setMessageType(e.target.value)}
              className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-300 text-sm transition-colors"
            >
              <option value="text">Plain Text</option>
              <option value="image">Image (via URL)</option>
              <option value="document">Document (via URL)</option>
              <option value="audio">Audio / Push-to-Talk (via URL)</option>
            </select>
          </div>
        </div>

        <div className="space-y-4 flex flex-col justify-between">
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              {messageType === 'text' ? 'Message Content' : 'Media Direct URL / Payload'}
            </label>
            <textarea
              required
              disabled={!isConnected}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={messageType === 'text' ? 'Type your message here...' : 'https://example.com/media.jpg'}
              rows={3}
              className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-200 placeholder-zinc-600 text-sm transition-colors resize-none"
            />
          </div>

          {(messageType === 'image' || messageType === 'document') && (
            <div>
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Attachment Custom Filename</label>
              <input
                type="text"
                disabled={!isConnected}
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder="e.g. report.pdf"
                className="w-full px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl focus:outline-none focus:border-emerald-500 text-zinc-200 placeholder-zinc-600 text-sm transition-colors"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={sending || !isConnected}
            className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 text-zinc-950 disabled:text-zinc-600 font-bold rounded-xl transition-all active:scale-[0.98]"
          >
            {sending ? (
              <div className="w-5 h-5 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <Send className="w-4 h-4" />
                Transmit Message Payload
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
