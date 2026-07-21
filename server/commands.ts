import { getBotMode, setBotMode, addLog, getAntiDelete, setAntiDelete } from './db';
import fs from 'fs';
import path from 'path';
import { downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { getJoke, getFact } from './joke_fact';
import { getGptResponse, downloadQuotedMedia } from './ai';

const serverStartTime = Date.now();

export interface CommandContext {
  sock: any;
  msg: any;
  chatJid: string;
  senderJid: string;
  args: string[];
  userId: string;
  email: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  category: string;
  description: string;
  usage: string;
  ownerOnly?: boolean;
  handler: (ctx: CommandContext) => Promise<void> | void;
}

interface CachedMessage {
  id: string;
  chatJid: string;
  chatName: string;
  senderJid: string;
  senderName: string;
  timestamp: number;
  originalMsg: any;
  edits?: any[];
}

// Track stats in memory per-session
const sessionMessageCount = new Map<string, number>();

// Track recovered View Once message IDs to prevent duplicate recoveries
const recoveredMessageIds = new Set<string>();

// Persistent Message Store class to save messages on disk/cache across restarts
class PersistentMessageStore {
  private filePath: string;
  private cache: CachedMessage[] = [];
  private maxCapacity = 5000;

  constructor(userId: string) {
    this.filePath = path.join(process.cwd(), 'data', `messages_${userId}.json`);
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        this.cache = JSON.parse(content || '[]');
        this.cleanOldRecords();
      }
    } catch (e) {
      console.error(`[PersistentMessageStore] Error loading messages from ${this.filePath}:`, e);
      this.cache = [];
    }
  }

  private cleanOldRecords() {
    // Keep messages for up to 7 days to optimize storage
    const oneWeekAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
    const initialLength = this.cache.length;
    
    const toRemove = this.cache.filter(m => m.timestamp < oneWeekAgo);
    for (const msg of toRemove) {
      this.deleteMediaFile(msg.id);
    }
    
    this.cache = this.cache.filter(m => m.timestamp >= oneWeekAgo);
    if (this.cache.length !== initialLength) {
      this.save();
    }
  }

  private save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2));
    } catch (e) {
      console.error(`[PersistentMessageStore] Error saving messages to ${this.filePath}:`, e);
    }
  }

  public add(msg: CachedMessage) {
    const existingIdx = this.cache.findIndex(m => m.id === msg.id);
    if (existingIdx !== -1) {
      this.cache[existingIdx] = msg;
    } else {
      this.cache.push(msg);
    }

    if (this.cache.length > this.maxCapacity) {
      const oldMsg = this.cache.shift();
      if (oldMsg) {
        this.deleteMediaFile(oldMsg.id);
      }
    }
    this.save();
  }

  public find(id: string): CachedMessage | undefined {
    return this.cache.find(m => m.id === id);
  }

  public updateChatName(id: string, chatName: string) {
    const msg = this.cache.find(m => m.id === id);
    if (msg) {
      msg.chatName = chatName;
      this.save();
    }
  }

  private deleteMediaFile(msgId: string) {
    const mediaPath = path.join(process.cwd(), 'data', 'baileys_media', `${msgId}.bin`);
    const metadataPath = path.join(process.cwd(), 'data', 'baileys_media', `${msgId}.meta.json`);
    try {
      if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
      if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
    } catch (e) {}
  }
}

const stores = new Map<string, PersistentMessageStore>();

export function getMessageStore(userId: string): PersistentMessageStore {
  let store = stores.get(userId);
  if (!store) {
    store = new PersistentMessageStore(userId);
    stores.set(userId, store);
  }
  return store;
}

// Track processed deleted message IDs to prevent double notifications
const processedDeletions = new Set<string>();

export function isDeletionProcessed(deletedId: string): boolean {
  if (processedDeletions.has(deletedId)) {
    return true;
  }
  processedDeletions.add(deletedId);
  if (processedDeletions.size > 1000) {
    const firstValue = processedDeletions.values().next().value;
    if (firstValue !== undefined) {
      processedDeletions.delete(firstValue);
    }
  }
  return false;
}

export function unwrapMessage(message: any): any {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV3?.message) {
    return unwrapMessage(message.viewOnceMessageV3.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

export function isViewOnceMessage(msg: any): boolean {
  if (!msg || !msg.message) return false;
  
  const m = msg.message;
  // Direct check for View Once wrappers
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV3 || m.viewOnceMessageV2Extension) {
    return true;
  }
  
  // Recursively check inside ephemeralMessage
  if (m.ephemeralMessage?.message) {
    const ephem = m.ephemeralMessage.message;
    if (ephem.viewOnceMessage || ephem.viewOnceMessageV2 || ephem.viewOnceMessageV3 || ephem.viewOnceMessageV2Extension) {
      return true;
    }
  }

  // Check unwrapped media message properties
  const unwrapped = unwrapMessage(m);
  if (unwrapped) {
    if (unwrapped.imageMessage?.viewOnce || unwrapped.videoMessage?.viewOnce || unwrapped.audioMessage?.viewOnce) {
      return true;
    }
  }

  return false;
}

export async function silentRecoverAndForward(
  sock: any,
  msgKey: any,
  unwrappedMessage: any,
  senderJid: string,
  pushName: string,
  timestamp: number,
  chatJid: string,
  userId: string,
  email: string
): Promise<boolean> {
  const ownerJid = cleanJid(sock.user?.id || '');
  if (!ownerJid) {
    console.error('[ViewOnceSaver] Failed to determine owner JID.');
    return false;
  }

  const msgId = msgKey.id;
  if (!msgId) return false;

  // Prevent duplicate forwarding
  if (recoveredMessageIds.has(msgId)) {
    console.log(`[ViewOnceSaver] Message ${msgId} has already been recovered.`);
    return true;
  }

  const mediaDetails = getMediaDetails(unwrappedMessage);
  if (!mediaDetails) {
    console.log(`[ViewOnceSaver] No media details found for message ${msgId}.`);
    return false;
  }

  const senderNumber = senderJid.split('@')[0];
  const dateObj = new Date(timestamp * 1000);
  const dateStr = dateObj.toISOString().split('T')[0];
  const timeStr = dateObj.toTimeString().split(' ')[0];

  const chatName = await resolveChatName(sock, chatJid);

  let originalCaption = '';
  if (unwrappedMessage.imageMessage) {
    originalCaption = unwrappedMessage.imageMessage.caption || '';
  } else if (unwrappedMessage.videoMessage) {
    originalCaption = unwrappedMessage.videoMessage.caption || '';
  } else if (unwrappedMessage.documentMessage) {
    originalCaption = unwrappedMessage.documentMessage.caption || '';
  }

  const headerText = `🔓 *View Once Recovered*
━━━━━━━━━━━━━━━━━━━
👤 *Sender:* ${pushName && pushName !== 'Unknown User' ? `${pushName} ` : ''}(@${senderNumber})
👥 *Chat:* ${chatName}
📅 *Date:* ${dateStr}
🕒 *Time:* ${timeStr}`;

  let captionText = headerText;
  if (originalCaption) {
    captionText += `\n📝 *Caption:* ${originalCaption}`;
  }

  const quotedMsgObj = {
    key: msgKey,
    message: unwrappedMessage
  };

  console.log(`[ViewOnceSaver] Downloading View Once media for message ${msgId}...`);

  try {
    const buffer = await downloadMediaMessage(
      quotedMsgObj,
      'buffer',
      {},
      {
        rekeyRequest: () => Promise.resolve()
      } as any
    );

    if (!buffer) {
      throw new Error('Downloaded buffer is null or empty');
    }

    console.log(`[ViewOnceSaver] Successfully downloaded View Once media. Forwarding to owner: ${ownerJid}`);

    if (unwrappedMessage.imageMessage) {
      await sock.sendMessage(ownerJid, {
        image: buffer,
        caption: captionText,
        mentions: [senderJid]
      });
    } else if (unwrappedMessage.videoMessage) {
      const isGif = !!unwrappedMessage.videoMessage.gifPlayback;
      await sock.sendMessage(ownerJid, {
        video: buffer,
        caption: captionText,
        gifPlayback: isGif,
        mentions: [senderJid]
      });
    } else if (unwrappedMessage.documentMessage) {
      await sock.sendMessage(ownerJid, {
        document: buffer,
        mimetype: unwrappedMessage.documentMessage.mimetype || 'application/octet-stream',
        fileName: unwrappedMessage.documentMessage.fileName || 'document',
        caption: captionText,
        mentions: [senderJid]
      });
    } else if (unwrappedMessage.audioMessage) {
      await sock.sendMessage(ownerJid, { 
        text: captionText, 
        mentions: [senderJid] 
      });
      
      const isPtt = !!unwrappedMessage.audioMessage.ptt;
      await sock.sendMessage(ownerJid, {
        audio: buffer,
        mimetype: unwrappedMessage.audioMessage.mimetype || 'audio/ogg; codecs=opus',
        ptt: isPtt,
        seconds: unwrappedMessage.audioMessage.seconds,
        waveform: unwrappedMessage.audioMessage.waveform
      });
    } else if (unwrappedMessage.stickerMessage) {
      await sock.sendMessage(ownerJid, { 
        text: captionText, 
        mentions: [senderJid] 
      });
      
      await sock.sendMessage(ownerJid, {
        sticker: buffer
      });
    } else {
      await sock.sendMessage(ownerJid, { 
        text: captionText, 
        mentions: [senderJid] 
      });
      
      await sock.sendMessage(ownerJid, {
        document: buffer,
        mimetype: mediaDetails.mimetype || 'application/octet-stream',
        fileName: mediaDetails.filename || 'recovered_file'
      });
    }

    recoveredMessageIds.add(msgId);
    addLog(userId, email, 'view_once_recovered', `Silently recovered ${mediaDetails.type} view-once message from @${senderNumber}`);
    return true;
  } catch (err) {
    console.error(`[ViewOnceSaver] Error recovering view once media for message ${msgId}:`, err);
    return false;
  }
}

export function getContextInfo(unwrapped: any): any {
  if (!unwrapped) return null;
  const keys = Object.keys(unwrapped);
  for (const key of keys) {
    if (unwrapped[key] && typeof unwrapped[key] === 'object' && 'contextInfo' in unwrapped[key]) {
      return unwrapped[key].contextInfo;
    }
  }
  return unwrapped.contextInfo || null;
}

export interface MediaMetadata {
  mimetype: string;
  filename?: string;
  caption?: string;
  type: string;
}

export function getMediaDetails(unwrapped: any): MediaMetadata | null {
  if (!unwrapped) return null;

  if (unwrapped.imageMessage) {
    return {
      type: 'image',
      mimetype: unwrapped.imageMessage.mimetype || 'image/jpeg',
      caption: unwrapped.imageMessage.caption || undefined
    };
  }
  if (unwrapped.videoMessage) {
    return {
      type: 'video',
      mimetype: unwrapped.videoMessage.mimetype || 'video/mp4',
      caption: unwrapped.videoMessage.caption || undefined
    };
  }
  if (unwrapped.audioMessage) {
    return {
      type: 'audio',
      mimetype: unwrapped.audioMessage.mimetype || 'audio/ogg; codecs=opus'
    };
  }
  if (unwrapped.stickerMessage) {
    return {
      type: 'sticker',
      mimetype: unwrapped.stickerMessage.mimetype || 'image/webp'
    };
  }
  if (unwrapped.documentMessage) {
    return {
      type: 'document',
      mimetype: unwrapped.documentMessage.mimetype || 'application/octet-stream',
      filename: unwrapped.documentMessage.fileName || unwrapped.documentMessage.title || 'document',
      caption: unwrapped.documentMessage.caption || undefined
    };
  }

  return null;
}

const MEDIA_DIR = path.join(process.cwd(), 'data', 'baileys_media');
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

export async function saveMediaIfPresent(userId: string, msg: any, sock: any) {
  try {
    const unwrapped = unwrapMessage(msg.message);
    const mediaDetails = getMediaDetails(unwrapped);
    if (!mediaDetails) return;

    const msgId = msg.key.id;
    if (!msgId) return;

    const mediaPath = path.join(MEDIA_DIR, `${msgId}.bin`);
    const metadataPath = path.join(MEDIA_DIR, `${msgId}.meta.json`);

    if (fs.existsSync(mediaPath)) return;

    console.log(`[AntiDelete] Downloading media for message ${msgId}...`);

    const cleanMsg = {
      key: msg.key,
      message: unwrapped
    };

    const buffer = await downloadMediaMessage(
      cleanMsg,
      'buffer',
      {},
      {
        rekeyRequest: () => Promise.resolve()
      } as any
    );

    if (buffer) {
      fs.writeFileSync(mediaPath, buffer);
      fs.writeFileSync(metadataPath, JSON.stringify(mediaDetails, null, 2));
      console.log(`[AntiDelete] Successfully cached media for message ${msgId}`);
    }
  } catch (err) {
    console.error(`[AntiDelete] Failed to save media for message ${msg.key?.id}:`, err);
  }
}

// In-memory cache for group names to prevent redundant groupMetadata network queries
const groupNameCache = new Map<string, string>();

export function incrementMessageCount(userId: string) {
  const current = sessionMessageCount.get(userId) || 0;
  sessionMessageCount.set(userId, current + 1);
}

function formatUptime(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

// Clean JID to basic format: uses jidNormalizedUser with robust fallback
export function cleanJid(jid: string): string {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid);
  } catch (e) {
    const parts = jid.split('@');
    if (parts.length < 2) return jid;
    const user = parts[0].split(':')[0];
    const server = parts[1];
    return `${user}@${server}`;
  }
}

// Get the actual sender JID, accounting for fromMe messages (sent by the bot/owner)
export function getSenderJid(msg: any, ownerJid: string): string {
  if (msg.key?.fromMe) {
    return ownerJid;
  }
  const rawJid = msg.key?.participant || msg.key?.remoteJid || '';
  return cleanJid(rawJid);
}

// Resolves a readable chat name asynchronously
export async function resolveChatName(sock: any, chatJid: string): Promise<string> {
  if (!chatJid) return 'Unknown Chat';
  if (chatJid.endsWith('@g.us')) {
    const cached = groupNameCache.get(chatJid);
    if (cached) return cached;
    try {
      if (typeof sock.groupMetadata === 'function') {
        const metadata = await sock.groupMetadata(chatJid);
        if (metadata && metadata.subject) {
          groupNameCache.set(chatJid, metadata.subject);
          return metadata.subject;
        }
      }
    } catch (e) {
      // query failed, return generic
    }
    return 'Group Chat';
  } else if (chatJid.endsWith('@s.whatsapp.net')) {
    return 'Personal Chat';
  } else if (chatJid.endsWith('@newsletter')) {
    return 'Channel/Newsletter';
  }
  return chatJid;
}

// Caches an incoming message for later revocation recovery
export function cacheMessage(userId: string, chatJid: string, chatName: string, msg: any, sock: any) {
  if (!msg.key || !msg.key.id) return;

  const ownerJid = cleanJid(sock?.user?.id || '');
  const senderJid = getSenderJid(msg, ownerJid);
  const senderName = msg.key.fromMe ? 'You (Bot Owner)' : (msg.pushName || 'Unknown User');
  const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000);

  const cachedMsg: CachedMessage = {
    id: msg.key.id,
    chatJid,
    chatName,
    senderJid,
    senderName,
    timestamp,
    originalMsg: msg
  };

  const store = getMessageStore(userId);
  store.add(cachedMsg);

  // Download and cache media asynchronously in the background so it doesn't block the connection
  saveMediaIfPresent(userId, msg, sock).catch((err) => {
    console.error('[AntiDelete] Failed to save media asynchronously:', err);
  });
}

// Check if message is a revocation request
export function isRevokeMessage(messageContent: any): boolean {
  if (!messageContent) return false;
  const proto = messageContent.protocolMessage;
  if (!proto) return false;
  // Type 3 is ProtocolMessage.Type.REVOKE
  return proto.type === 3 || proto.type === 'REVOKE' || proto.type === 4;
}

// Helper to identify message content details
function getMessageDetails(message: any): { text: string; type: string; isMedia: boolean } {
  if (!message) return { text: '', type: 'Unknown', isMedia: false };

  // If it's a protocolMessage of type 14 (EDIT), extract the edited message
  if (message.protocolMessage && (message.protocolMessage.type === 14 || message.protocolMessage.type === 'EDIT')) {
    const edited = message.protocolMessage.editedMessage;
    if (edited) {
      const subDetails = getMessageDetails(unwrapMessage(edited));
      return {
        text: `[Edited] ${subDetails.text}`,
        type: `edited_${subDetails.type}`,
        isMedia: subDetails.isMedia
      };
    }
  }

  if (message.conversation) {
    return { text: message.conversation, type: 'text', isMedia: false };
  }
  if (message.extendedTextMessage?.text) {
    return { text: message.extendedTextMessage.text, type: 'text', isMedia: false };
  }

  if (message.imageMessage) {
    return { text: message.imageMessage.caption || '', type: 'image', isMedia: true };
  }
  if (message.videoMessage) {
    const isGif = !!message.videoMessage.gifPlayback;
    return { text: message.videoMessage.caption || '', type: isGif ? 'gif' : 'video', isMedia: true };
  }
  if (message.audioMessage) {
    const isVoice = !!message.audioMessage.ptt;
    return { text: '', type: isVoice ? 'voice_note' : 'audio', isMedia: true };
  }
  if (message.documentMessage) {
    const title = message.documentMessage.fileName || message.documentMessage.title || 'Document';
    return { text: title, type: 'document', isMedia: true };
  }
  if (message.stickerMessage) {
    return { text: '', type: 'sticker', isMedia: true };
  }
  if (message.locationMessage) {
    const lat = message.locationMessage.degreesLatitude;
    const lng = message.locationMessage.degreesLongitude;
    const name = message.locationMessage.name || '';
    const address = message.locationMessage.address || '';
    const details = [name, address, `Lat: ${lat}, Lng: ${lng}`].filter(Boolean).join('\n');
    return { text: `📍 Location:\n${details}`, type: 'location', isMedia: false };
  }
  if (message.contactMessage) {
    const name = message.contactMessage.displayName || '';
    const vcard = message.contactMessage.vcard || '';
    return { text: `👤 Contact: ${name}\n${vcard}`, type: 'contact', isMedia: false };
  }
  if (message.contactsArrayMessage) {
    const count = message.contactsArrayMessage.contacts?.length || 0;
    const names = (message.contactsArrayMessage.contacts || []).map((c: any) => c.displayName).filter(Boolean).join(', ');
    return { text: `👥 Contacts List (${count} contacts): ${names}`, type: 'contacts_array', isMedia: false };
  }
  if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
    const poll = message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3;
    const question = poll.name || '';
    const options = (poll.options || []).map((opt: any) => `• ${opt.optionName || ''}`).join('\n');
    return { text: `📊 Poll Question: ${question}\nOptions:\n${options}`, type: 'poll', isMedia: false };
  }
  if (message.reactionMessage) {
    const reaction = message.reactionMessage;
    const text = reaction.text || '';
    const targetId = reaction.key?.id || '';
    return { text: `Reaction: ${text} on message ID: ${targetId}`, type: 'reaction', isMedia: false };
  }
  if (message.buttonsMessage) {
    const btnMsg = message.buttonsMessage;
    const text = btnMsg.contentText || '';
    const btns = (btnMsg.buttons || []).map((b: any) => `[${b.buttonText?.displayText || ''}]`).join(' ');
    return { text: `${text}\nButtons: ${btns}`, type: 'buttons', isMedia: false };
  }
  if (message.templateMessage) {
    const tmplt = message.templateMessage;
    const text = tmplt.hydratedTemplate?.hydratedContentText || '';
    return { text, type: 'template', isMedia: false };
  }
  if (message.interactiveMessage) {
    const interactive = message.interactiveMessage;
    const title = interactive.header?.title || '';
    const body = interactive.body?.text || '';
    const footer = interactive.footer?.text || '';
    return { text: `${title}\n${body}\n${footer}`.trim(), type: 'interactive', isMedia: false };
  }
  if (message.listMessage) {
    const list = message.listMessage;
    const title = list.title || '';
    const desc = list.description || '';
    return { text: `${title}\n${desc}`.trim(), type: 'list', isMedia: false };
  }

  // Fallback to extract first key
  const keys = Object.keys(message);
  if (keys.length > 0) {
    const mainKey = keys[0];
    const nested = message[mainKey];
    if (nested && typeof nested === 'object') {
      const text = nested.text || nested.caption || nested.conversation || '';
      return { 
        text, 
        type: mainKey.replace('Message', ''), 
        isMedia: !!(nested.url || nested.mimetype) 
      };
    }
  }

  return { text: '', type: 'Other', isMedia: false };
}

// Recovers a deleted message and sends details to the owner's personal chat
export async function handleDeletedMessage(sock: any, userId: string, deletedId: string, email: string, chatJid?: string, deletedByOwner?: boolean) {
  // Deduplicate delete events
  if (isDeletionProcessed(deletedId)) {
    console.log(`[AntiDelete] Deletion already processed for message ID: ${deletedId}, ignoring duplicate.`);
    return;
  }

  // A tiny 1-second delay to allow any concurrent media downloads to fully complete
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const ownerJid = cleanJid(sock.user?.id || '');
  if (!ownerJid) return;

  // Never recover or forward if the event belongs to the owner's self chat (Saved Messages / Message Yourself)
  if (chatJid && cleanJid(chatJid) === ownerJid) {
    console.log(`[AntiDelete] Deletion in self-chat (${chatJid}) ignored completely.`);
    return;
  }

  const store = getMessageStore(userId);
  const found = store.find(deletedId);

  if (found && cleanJid(found.chatJid) === ownerJid) {
    console.log(`[AntiDelete] Deletion in self-chat (from cache: ${found.chatJid}) ignored completely.`);
    return;
  }

  if (!found) {
    if (deletedByOwner) {
      console.log(`[AntiDelete] Deletion by owner ignored (not in cache).`);
      return;
    }
    // Notify about deletion, but mention it wasn't cached
    await sock.sendMessage(ownerJid, {
      text: `🗑️ *Anti Delete Detected*
━━━━━━━━━━━━━━━━━━━
⚠️ _A message was deleted, but it was not found in the bot's persistent cache (sent before the bot started, cache cleared, or from unsupported source)._
• *Message ID:* ${deletedId}`
    });
    return;
  }

  const dateObj = new Date(found.timestamp * 1000);
  const dateStr = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = dateObj.toTimeString().split(' ')[0]; // HH:MM:SS
  
  const unwrapped = unwrapMessage(found.originalMsg.message);
  const details = getMessageDetails(unwrapped);

  const senderNumber = found.senderJid.split('@')[0];

  let originalText = '';
  if (details.text) {
    originalText = details.text;
  } else {
    // If no text/caption, use a descriptive tag based on type
    if (details.type === 'image') originalText = '📷 [Photo]';
    else if (details.type === 'video') originalText = '🎥 [Video]';
    else if (details.type === 'gif') originalText = '👾 [GIF]';
    else if (details.type === 'audio') originalText = '🎵 [Audio]';
    else if (details.type === 'voice_note') originalText = '🎙️ [Voice Note]';
    else if (details.type === 'sticker') originalText = '🎨 [Sticker]';
    else if (details.type === 'document') originalText = '📄 [Document]';
    else if (details.type === 'location') originalText = '📍 [Location]';
    else if (details.type === 'contact') originalText = '👤 [Contact]';
    else if (details.type === 'contacts_array') originalText = '👥 [Contacts List]';
    else if (details.type === 'poll') originalText = '📊 [Poll]';
    else if (details.type === 'reaction') originalText = '👍 [Reaction]';
    else originalText = `📦 [${details.type.toUpperCase()}]`;
  }

  let notificationText = `🗑️ Anti Delete Detected

👤 Sender: @${senderNumber}
👥 Chat: ${found.chatName}
📅 Date: ${dateStr}
🕒 Time: ${timeStr}

Deleted Message:
${originalText}`;

  if (found.edits && found.edits.length > 0) {
    notificationText += `\n\n✏️ Edit History:`;
    found.edits.forEach((oldMsg: any, idx: number) => {
      const oldDetails = getMessageDetails(unwrapMessage(oldMsg));
      const textVal = oldDetails.text || `[Media: ${oldDetails.type.toUpperCase()}]`;
      notificationText += `\n• [Version ${idx + 1}]: ${textVal}`;
    });
  }

  // Log to DB for debugging and auditing
  addLog(
    userId, 
    email, 
    'antidelete_detection', 
    `Recovered deleted ${details.type} message from @${senderNumber} in "${found.chatName}"`
  );

  // Recover and forward media or attachments if present
  const mediaPath = path.join(MEDIA_DIR, `${deletedId}.bin`);
  const metadataPath = path.join(MEDIA_DIR, `${deletedId}.meta.json`);

  let mediaSent = false;

  const contextInfo = getContextInfo(unwrapped);

  if (fs.existsSync(mediaPath) && fs.existsSync(metadataPath)) {
    try {
      const buffer = fs.readFileSync(mediaPath);
      const metadata: MediaMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

      console.log(`[AntiDelete] Sending re-uploaded media for ${deletedId}...`);
      
      const sendOpts: any = {};
      if (contextInfo) {
        sendOpts.contextInfo = contextInfo;
      }
      sendOpts.mentions = [found.senderJid];

      if (metadata.type === 'image') {
        sendOpts.image = buffer;
        sendOpts.caption = notificationText;
        await sock.sendMessage(ownerJid, sendOpts);
        mediaSent = true;
      } else if (metadata.type === 'video' || metadata.type === 'gif') {
        sendOpts.video = buffer;
        sendOpts.caption = notificationText;
        sendOpts.gifPlayback = metadata.type === 'gif';
        await sock.sendMessage(ownerJid, sendOpts);
        mediaSent = true;
      } else if (metadata.type === 'document') {
        sendOpts.document = buffer;
        sendOpts.mimetype = metadata.mimetype;
        sendOpts.fileName = metadata.filename;
        sendOpts.caption = notificationText;
        await sock.sendMessage(ownerJid, sendOpts);
        mediaSent = true;
      } else if (metadata.type === 'audio' || metadata.type === 'voice_note') {
        // Send report text first, then audio (since audio doesn't support captions)
        await sock.sendMessage(ownerJid, { text: notificationText, mentions: [found.senderJid], contextInfo });
        
        sendOpts.audio = buffer;
        sendOpts.mimetype = metadata.mimetype;
        sendOpts.ptt = metadata.type === 'voice_note';
        await sock.sendMessage(ownerJid, sendOpts);
        mediaSent = true;
      } else if (metadata.type === 'sticker') {
        // Send report text first, then sticker (since stickers don't support captions)
        await sock.sendMessage(ownerJid, { text: notificationText, mentions: [found.senderJid], contextInfo });
        
        sendOpts.sticker = buffer;
        await sock.sendMessage(ownerJid, sendOpts);
        mediaSent = true;
      }
    } catch (err) {
      console.error(`[AntiDelete] Failed to send re-uploaded media for ${deletedId}:`, err);
    }
  }

  // Fallback to copyNForward / forward if local re-upload was not performed/failed
  if (!mediaSent && found.originalMsg.message) {
    try {
      // Send the report text first
      await sock.sendMessage(ownerJid, { text: notificationText, mentions: [found.senderJid], contextInfo });

      if (typeof sock.copyNForward === 'function') {
        await sock.copyNForward(ownerJid, found.originalMsg, false);
      } else {
        await sock.sendMessage(ownerJid, { forward: found.originalMsg });
      }
      mediaSent = true;
    } catch (forwardErr) {
      console.error('[AntiDelete] Failed to forward original media message:', forwardErr);
      if (details.isMedia) {
        await sock.sendMessage(ownerJid, {
          text: `⚠️ _Could not forward the original media file. It may have expired on WhatsApp servers._`
        });
      }
    }
  }

  // If still not sent (e.g., text message with no media), send text notification
  if (!mediaSent) {
    const sendOpts: any = { 
      text: notificationText,
      mentions: [found.senderJid]
    };
    if (contextInfo) {
      sendOpts.contextInfo = contextInfo;
    }
    await sock.sendMessage(ownerJid, sendOpts);
  }
}

export const commands: Command[] = [
  {
    name: 'mode',
    category: '⚙️ SYSTEM',
    description: 'Switches the bot command mode (public or private)',
    usage: '.mode [public|private]',
    ownerOnly: true,
    handler: async (ctx) => {
      const { sock, msg, chatJid, args, userId, email } = ctx;

      if (args.length === 0) {
        const currentMode = getBotMode(userId);
        const capitalizedMode = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
        await sock.sendMessage(chatJid, { 
          text: `ℹ️ *Current Mode:* ${capitalizedMode}\nUse \`.mode public\` or \`.mode private\` to change it.` 
        }, { quoted: msg });
        return;
      }

      const targetMode = args[0].toLowerCase();
      if (targetMode === 'public') {
        setBotMode(userId, 'public');
        addLog(userId, email, 'mode_change', 'Command mode changed to Public.');
        await sock.sendMessage(chatJid, { text: '✅ Mode has been set to Public.' }, { quoted: msg });
      } else if (targetMode === 'private') {
        setBotMode(userId, 'private');
        addLog(userId, email, 'mode_change', 'Command mode changed to Private.');
        await sock.sendMessage(chatJid, { text: '🔒 Mode has been set to Private.' }, { quoted: msg });
      } else {
        await sock.sendMessage(chatJid, { text: '❌ Invalid mode. Use `.mode public` or `.mode private`' }, { quoted: msg });
      }
    }
  },
  {
    name: 'antidelete',
    category: '⚙️ SYSTEM',
    description: 'Enables or disables Anti-Delete system',
    usage: '.antidelete [on|off]',
    ownerOnly: true,
    handler: async (ctx) => {
      const { sock, msg, chatJid, args, userId, email } = ctx;

      if (args.length === 0) {
        const isEnabled = getAntiDelete(userId);
        await sock.sendMessage(chatJid, {
          text: `ℹ️ *Anti-Delete:* ${isEnabled ? 'Enabled ✅' : 'Disabled ❌'}\nUse \`.antidelete on\` or \`.antidelete off\` to toggle it.`
        }, { quoted: msg });
        return;
      }

      const input = args[0].toLowerCase();
      if (input === 'on' || input === 'enable' || input === 'true') {
        setAntiDelete(userId, true);
        addLog(userId, email, 'antidelete_toggle', 'Anti-Delete enabled.');
        await sock.sendMessage(chatJid, { text: '✅ Anti-Delete has been enabled.' }, { quoted: msg });
      } else if (input === 'off' || input === 'disable' || input === 'false') {
        setAntiDelete(userId, false);
        addLog(userId, email, 'antidelete_toggle', 'Anti-Delete disabled.');
        await sock.sendMessage(chatJid, { text: '❌ Anti-Delete has been disabled.' }, { quoted: msg });
      } else {
        await sock.sendMessage(chatJid, { text: '❌ Invalid state. Use `.antidelete on` or `.antidelete off`' }, { quoted: msg });
      }
    }
  },
  {
    name: 'alive',
    category: '⚙️ SYSTEM',
    description: 'Checks whether the bot is online and get system status',
    usage: '.alive',
    handler: async (ctx) => {
      const { sock, msg, chatJid, userId } = ctx;
      const currentMode = getBotMode(userId);
      const capitalizedMode = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
      const isAntiDeleteOn = getAntiDelete(userId);
      const ownNumber = sock.user?.id.split(':')[0] || 'Unknown';
      const uptimeStr = formatUptime(Date.now() - serverStartTime);

      const statusMsg = `🤖 *Hijjaze Bot* is online and running!
━━━━━━━━━━━━━━━━━━━
🟢 *Status:* Online
⚙️ *Mode:* ${capitalizedMode}
🛡️ *Anti-Delete:* ${isAntiDeleteOn ? 'Enabled ✅' : 'Disabled ❌'}
⏱️ *Uptime:* ${uptimeStr}
📱 *Account Number:* +${ownNumber}`;

      await sock.sendMessage(chatJid, { text: statusMsg }, { quoted: msg });
    }
  },
  {
    name: 'menu',
    aliases: ['help'],
    category: '⚙️ SYSTEM',
    description: 'Displays this beautiful command menu',
    usage: '.menu',
    handler: async (ctx) => {
      const { sock, msg, chatJid } = ctx;
      
      // Group commands by category
      const categories: { [key: string]: Command[] } = {};
      commands.forEach(cmd => {
        if (!categories[cmd.category]) {
          categories[cmd.category] = [];
        }
        categories[cmd.category].push(cmd);
      });

      let menuText = `🌟 *HIJJAZE BOT - COMMAND MENU* 🌟\n━━━━━━━━━━━━━━━━━━━\n\n`;

      for (const cat of Object.keys(categories)) {
        menuText += `${cat} COMMANDS\n`;
        categories[cat].forEach(cmd => {
          menuText += `  • *.${cmd.name}*\n`;
          menuText += `    _${cmd.description}_\n`;
          menuText += `    _Usage: ${cmd.usage}_\n`;
        });
        menuText += `\n`;
      }

      menuText += `━━━━━━━━━━━━━━━━━━━\n💡 _Tip: Use commands starting with a dot (.) prefix._`;

      await sock.sendMessage(chatJid, { text: menuText }, { quoted: msg });
    }
  },
  {
    name: 'ping',
    category: '🛠️ UTILITY',
    description: 'Checks the response speed / latency of the bot',
    usage: '.ping',
    handler: async (ctx) => {
      const { sock, msg, chatJid } = ctx;
      const start = Date.now();
      const tempMsg = await sock.sendMessage(chatJid, { text: '⚡ Ping...' }, { quoted: msg });
      const latency = Date.now() - start;
      try {
        await sock.sendMessage(chatJid, { 
          text: `🏓 *Pong!*\nLatency: \`${latency}ms\``,
          edit: tempMsg.key
        });
      } catch (e) {
        // Fallback if edit fails
        await sock.sendMessage(chatJid, { 
          text: `🏓 *Pong!*\nLatency: \`${latency}ms\``
        }, { quoted: msg });
      }
    }
  },
  {
    name: 'stats',
    category: '🛠️ UTILITY',
    description: 'Shows active stats of the current WhatsApp session',
    usage: '.stats',
    handler: async (ctx) => {
      const { sock, msg, chatJid, userId } = ctx;
      const msgsProcessed = sessionMessageCount.get(userId) || 0;
      const ownNumber = sock.user?.id.split(':')[0] || 'Unknown';
      
      const statsText = `📊 *SESSION STATISTICS*
━━━━━━━━━━━━━━━━━━━
📱 *Device:* +${ownNumber}
📨 *Messages Processed:* ${msgsProcessed}
🖥️ *Node Version:* ${process.version}
🔄 *Platform:* Linux`;

      await sock.sendMessage(chatJid, { text: statsText }, { quoted: msg });
    }
  },
  {
    name: 'vv',
    category: '🛠️ UTILITY',
    description: 'Silently recovers a replied View Once message and forwards it to your personal chat',
    usage: '.vv (replying to a View Once message)',
    ownerOnly: true,
    handler: async (ctx) => {
      const { sock, msg, chatJid, userId, email } = ctx;

      const ownerJid = cleanJid(sock.user?.id || '');
      if (!ownerJid) {
        console.error('[ViewOnceSaver] Failed to determine bot owner JID.');
        return;
      }

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
      if (!contextInfo || !contextInfo.quotedMessage) {
        await sock.sendMessage(ownerJid, { text: '❌ Reply to a View Once message.' });
        return;
      }

      const quotedMessage = contextInfo.quotedMessage;
      const unwrappedQuoted = unwrapMessage(quotedMessage);

      // Check if it is actually a View Once message format supported by WhatsApp & Baileys
      const isQuotedViewOnce = 
        !!quotedMessage.viewOnceMessage || 
        !!quotedMessage.viewOnceMessageV2 || 
        !!quotedMessage.viewOnceMessageV3 || 
        !!quotedMessage.viewOnceMessageV2Extension ||
        !!unwrappedQuoted?.imageMessage?.viewOnce ||
        !!unwrappedQuoted?.videoMessage?.viewOnce ||
        !!unwrappedQuoted?.audioMessage?.viewOnce;

      if (!isQuotedViewOnce) {
        await sock.sendMessage(ownerJid, { text: '❌ Reply to a View Once media message.' });
        return;
      }

      const mediaDetails = getMediaDetails(unwrappedQuoted);
      if (!mediaDetails) {
        await sock.sendMessage(ownerJid, { text: '❌ Reply to a View Once media message.' });
        return;
      }

      // Check for duplicate recovery
      if (contextInfo.stanzaId && recoveredMessageIds.has(contextInfo.stanzaId)) {
        await sock.sendMessage(ownerJid, { text: '❌ This View Once message has already been recovered.' });
        return;
      }

      const quotedSender = cleanJid(contextInfo.participant || chatJid);

      // Retrieve cached message details if available
      const store = getMessageStore(userId);
      const cachedMsg = store.find(contextInfo.stanzaId);
      const senderName = cachedMsg?.senderName || 'Unknown User';
      const timestamp = cachedMsg?.timestamp || Math.floor(Date.now() / 1000);

      const msgKey = {
        remoteJid: chatJid,
        id: contextInfo.stanzaId,
        fromMe: quotedSender === ownerJid,
        participant: contextInfo.participant || undefined
      };

      const success = await silentRecoverAndForward(
        sock,
        msgKey,
        unwrappedQuoted,
        quotedSender,
        senderName,
        timestamp,
        chatJid,
        userId,
        email
      );

      if (!success) {
        await sock.sendMessage(ownerJid, { text: '❌ Failed to recover the View Once media.' });
      }
    }
  },
  {
    name: 'joke',
    category: '🎉 FUN',
    description: 'Get a random, fresh, family-friendly joke',
    usage: '.joke [category]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const categoryPreference = args.length > 0 ? args[0] : undefined;

      try {
        const jokeObj = await getJoke(senderJid, categoryPreference);
        
        // Format the joke beautifully
        const formattedJoke = `🤣 *Random Joke*

━━━━━━━━━━━━━━━━━━

*${jokeObj.setup}*

${jokeObj.punchline}

💡 *Why it's funny:*
${jokeObj.explanation}

━━━━━━━━━━━━━━━━━━
✨ Type *.joke* again for another fresh joke.`;

        await sock.sendMessage(chatJid, { text: formattedJoke }, { quoted: msg });
      } catch (err) {
        console.error('Error generating or sending joke:', err);
        await sock.sendMessage(chatJid, { text: '❌ Failed to get a joke. Please try again!' }, { quoted: msg });
      }
    }
  },
  {
    name: 'fact',
    category: '🧠 INFORMATION',
    description: 'Get a random, highly interesting and amazing fact',
    usage: '.fact [topic]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const topicPreference = args.length > 0 ? args[0] : undefined;

      try {
        const factObj = await getFact(senderJid, topicPreference);

        // Format the fact beautifully
        const formattedFact = `🧠 *Amazing Fact*

━━━━━━━━━━━━━━━━━━

*${factObj.fact}*

📖 *Explanation:*
${factObj.explanation}

━━━━━━━━━━━━━━━━━━
🌍 Type *.fact* again to discover another amazing fact.`;

        await sock.sendMessage(chatJid, { text: formattedFact }, { quoted: msg });
      } catch (err) {
        console.error('Error generating or sending fact:', err);
        await sock.sendMessage(chatJid, { text: '❌ Failed to get a fact. Please try again!' }, { quoted: msg });
      }
    }
  },
  {
    name: 'gpt',
    category: '🤖 AI',
    description: 'Ask ChatGPT AI Assistant a question, or reply to a message with .gpt',
    usage: '.gpt [question]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      
      // Determine prompt text
      let promptText = args.join(' ').trim();
      let quotedMsg: any = null;
      let mediaFile: any = null;

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                          msg.message?.imageMessage?.contextInfo || 
                          msg.message?.videoMessage?.contextInfo || 
                          msg.message?.documentMessage?.contextInfo;
                          
      if (contextInfo?.quotedMessage) {
        quotedMsg = contextInfo.quotedMessage;
        
        // If user didn't specify prompt text, try to extract text from the quoted message
        if (!promptText) {
          const unwrappedQuoted = unwrapMessage(quotedMsg);
          if (unwrappedQuoted) {
            if (unwrappedQuoted.conversation) {
              promptText = unwrappedQuoted.conversation;
            } else if (unwrappedQuoted.extendedTextMessage?.text) {
              promptText = unwrappedQuoted.extendedTextMessage.text;
            } else if (unwrappedQuoted.imageMessage?.caption) {
              promptText = unwrappedQuoted.imageMessage.caption;
            } else if (unwrappedQuoted.videoMessage?.caption) {
              promptText = unwrappedQuoted.videoMessage.caption;
            } else if (unwrappedQuoted.documentMessage?.caption) {
              promptText = unwrappedQuoted.documentMessage.caption;
            }
          }
        }
      }

      // If no text prompt could be extracted and there's a quoted message, we'll try to download media first.
      if (quotedMsg) {
        try {
          mediaFile = await downloadQuotedMedia(quotedMsg);
        } catch (err) {
          console.error('[GPT] Error downloading media from quoted message:', err);
        }
      }

      // If still no prompt text and no media
      if (!promptText && !mediaFile) {
        await sock.sendMessage(chatJid, { text: '❌ Please provide a question or reply to a message.' }, { quoted: msg });
        return;
      }

      // If there is media but no prompt text, default the prompt to ask about the media
      if (mediaFile && !promptText) {
        const typeLabel = mediaFile.mimetype.split('/')[0] || 'file';
        promptText = `Analyze this ${typeLabel} and provide an informative summary or description.`;
      }

      // Set typing presence indicator
      try {
        await sock.sendPresenceUpdate('composing', chatJid);
      } catch (err) {
        // Ignored
      }

      try {
        const aiResponse = await getGptResponse(senderJid, promptText, mediaFile || undefined);

        // Build premium response layout
        const formattedResponse = `━━━━━━━━━━━━━━━━━━━━━━━
🤖 *HIJJAZE GPT*
━━━━━━━━━━━━━━━━━━━━━━━

💬 *Question*

${promptText}

━━━━━━━━━━━━━━━━━━━━━━━

🧠 *Answer*

${aiResponse}

━━━━━━━━━━━━━━━━━━━━━━━
⚡ Powered by Hijjaze Bot AI
━━━━━━━━━━━━━━━━━━━━━━━`;

        // Split the response if it exceeds limits (4000 characters)
        const chunks = splitMessage(formattedResponse, 4000);
        for (const chunk of chunks) {
          await sock.sendMessage(chatJid, { text: chunk }, { quoted: msg });
        }
      } catch (err: any) {
        console.error('Error generating GPT response:', err);
        const errMessage = err.message || '';
        if (errMessage.includes('API Key is not set') || errMessage.includes('unavailable')) {
          await sock.sendMessage(chatJid, { text: '❌ AI service is temporarily unavailable. Please try again later.' }, { quoted: msg });
        } else {
          await sock.sendMessage(chatJid, { text: '❌ An error occurred while generating the AI response. Please try again.' }, { quoted: msg });
        }
      } finally {
        try {
          await sock.sendPresenceUpdate('paused', chatJid);
        } catch (err) {
          // Ignored
        }
      }
    }
  }
];

function splitMessage(text: string, maxLength: number = 4000): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let current = text;
  
  while (current.length > 0) {
    if (current.length <= maxLength) {
      chunks.push(current);
      break;
    }
    
    let splitIdx = current.lastIndexOf('\n', maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.7) {
      splitIdx = current.lastIndexOf(' ', maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = maxLength;
    }
    
    chunks.push(current.substring(0, splitIdx).trim());
    current = current.substring(splitIdx).trim();
  }
  
  return chunks;
}

export async function handleIncomingMessage(sock: any, msg: any, userId: string, email: string) {
  if (!msg.message) return;

  const chatJid = msg.key.remoteJid;
  if (!chatJid) return;

  const unwrapped = unwrapMessage(msg.message);
  if (!unwrapped) return;

  // Intercept revoke / delete events
  const isProtocol = !!unwrapped.protocolMessage;
  const isProtoRevoke = isProtocol && (unwrapped.protocolMessage.type === 3 || unwrapped.protocolMessage.type === 'REVOKE');

  const stubType = msg.messageStubType;
  const isStubRevoke = stubType === 1 || stubType === 'REVOKE' || stubType === 28 || stubType === 68 || stubType === 118;

  if (isProtoRevoke || isStubRevoke) {
    const deletedId = isProtoRevoke ? unwrapped.protocolMessage.key?.id : msg.key?.id;
    const chatJidResolved = isProtoRevoke ? (unwrapped.protocolMessage.key?.remoteJid || msg.key?.remoteJid) : msg.key?.remoteJid;
    
    const ownerJid = cleanJid(sock.user?.id || '');
    const senderJid = getSenderJid(msg, ownerJid);
    const isOwner = msg.key.fromMe || senderJid === ownerJid;
    const antiDeleteEnabled = getAntiDelete(userId);

    console.log(`[AntiDelete] Revocation received in handleIncomingMessage. Deleted ID: ${deletedId}. Chat ID: ${chatJidResolved}. Enabled: ${antiDeleteEnabled}, Proto: ${!!isProtoRevoke}, Stub: ${!!isStubRevoke}, Owner: ${isOwner}`);

    if (antiDeleteEnabled && deletedId && chatJidResolved) {
      try {
        await handleDeletedMessage(sock, userId, deletedId, email, chatJidResolved, isOwner);
      } catch (err) {
        console.error('Error in handleDeletedMessage:', err);
      }
    }
    return; // Stop processing further for protocol/revoke messages
  }

  // Detect and silently recover View Once message automatically in the background
  if (!isProtocol && isViewOnceMessage(msg)) {
    const ownerJid = cleanJid(sock.user?.id || '');
    const senderJid = getSenderJid(msg, ownerJid);
    const pushName = msg.pushName || 'Unknown User';
    const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000);

    silentRecoverAndForward(
      sock,
      msg.key,
      unwrapped,
      senderJid,
      pushName,
      timestamp,
      chatJid,
      userId,
      email
    ).catch(err => {
      console.error('[ViewOnceSaver] Silent auto-recovery error:', err);
    });
  }

  // Cache regular incoming and outgoing messages
  if (!isProtocol) {
    // Cache immediately with default name to prevent race conditions
    const defaultChatName = chatJid.endsWith('@g.us') ? 'Group Chat' : (chatJid.endsWith('@s.whatsapp.net') ? 'Personal Chat' : chatJid);
    cacheMessage(userId, chatJid, defaultChatName, msg, sock);

    // Resolve details asynchronously and update chatName in cache
    resolveChatName(sock, chatJid).then((chatName) => {
      const store = getMessageStore(userId);
      if (msg.key?.id) {
        store.updateChatName(msg.key.id, chatName);
      }
    }).catch(err => {
      console.error('Error resolving chat name for cache:', err);
    });
  }

  // Track processing stats
  incrementMessageCount(userId);

  // Extract text for commands
  let text = '';
  if (unwrapped.conversation) {
    text = unwrapped.conversation;
  } else if (unwrapped.extendedTextMessage?.text) {
    text = unwrapped.extendedTextMessage.text;
  } else if (unwrapped.imageMessage?.caption) {
    text = unwrapped.imageMessage.caption;
  } else if (unwrapped.videoMessage?.caption) {
    text = unwrapped.videoMessage.caption;
  }

  text = text.trim();
  if (!text.startsWith('.')) return; // Prefix is dot (.)

  // Split command and arguments
  const parts = text.slice(1).split(' ');
  const cmdName = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Find command
  const command = commands.find(c => c.name === cmdName || (c.aliases && c.aliases.includes(cmdName)));
  if (!command) return;

  const ownerJid = cleanJid(sock.user?.id || '');
  const senderJid = getSenderJid(msg, ownerJid);
  const isOwner = msg.key.fromMe || senderJid === ownerJid;

  // Enforce owner-only commands
  if (command.ownerOnly && !isOwner) {
    // Completely ignore commands from non-owners to be 100% silent
    return;
  }

  // Determine mode
  const currentMode = getBotMode(userId);

  // Mode validation
  if (currentMode === 'private' && !isOwner) {
    // Completely ignore commands from non-owners in private mode to be 100% silent
    return;
  }

  // Execute command
  try {
    const ctx: CommandContext = {
      sock,
      msg,
      chatJid,
      senderJid,
      args,
      userId,
      email
    };
    await command.handler(ctx);
  } catch (err: any) {
    console.error(`Error executing command .${cmdName}:`, err);
    await sock.sendMessage(chatJid, { 
      text: `❌ *Error:* Failed to execute command \`.${cmdName}\`.` 
    }, { quoted: msg });
  }
}
