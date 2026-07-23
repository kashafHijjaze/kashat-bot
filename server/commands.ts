import { 
  getBotMode, 
  setBotMode, 
  addLog, 
  getAntiDelete, 
  setAntiDelete, 
  getChannelConfig, 
  setChannelConfig,
  addWarning,
  getWarnings,
  clearWarnings,
  muteUser,
  unmuteUser,
  isUserMuted,
  getMuteRecord,
  banUser,
  unbanUser,
  isUserBanned,
  getBanRecord
} from './db';
import fs from 'fs';
import path from 'path';
import { downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { getJoke, getFact } from './joke_fact';
import { getGptResponse, downloadQuotedMedia, generateImageBuffer } from './ai';
import { searchYouTubeVideo, downloadVideoBuffer, searchYouTubeAudio, downloadAudioBuffer } from './yt_downloader';

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

// Cache for .play audio downloads to prevent duplicate downloads
const playAudioCache = new Map<string, { audio: any; downloadResult: any; timestamp: number }>();

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

export function hasValidMediaKey(mediaObj: any): boolean {
  if (!mediaObj || typeof mediaObj !== 'object') return false;
  const key = mediaObj.mediaKey;
  if (!key) return false;
  if (typeof key === 'string' && key.trim().length === 0) return false;
  if (Buffer.isBuffer(key) && key.length === 0) return false;
  if (key instanceof Uint8Array && key.length === 0) return false;
  return true;
}

export function getMediaDetails(unwrapped: any): MediaMetadata | null {
  if (!unwrapped) return null;

  if (unwrapped.imageMessage && hasValidMediaKey(unwrapped.imageMessage)) {
    return {
      type: 'image',
      mimetype: unwrapped.imageMessage.mimetype || 'image/jpeg',
      caption: unwrapped.imageMessage.caption || undefined
    };
  }
  if (unwrapped.videoMessage && hasValidMediaKey(unwrapped.videoMessage)) {
    return {
      type: 'video',
      mimetype: unwrapped.videoMessage.mimetype || 'video/mp4',
      caption: unwrapped.videoMessage.caption || undefined
    };
  }
  if (unwrapped.audioMessage && hasValidMediaKey(unwrapped.audioMessage)) {
    return {
      type: 'audio',
      mimetype: unwrapped.audioMessage.mimetype || 'audio/ogg; codecs=opus'
    };
  }
  if (unwrapped.stickerMessage && hasValidMediaKey(unwrapped.stickerMessage)) {
    return {
      type: 'sticker',
      mimetype: unwrapped.stickerMessage.mimetype || 'image/webp'
    };
  }
  if (unwrapped.documentMessage && hasValidMediaKey(unwrapped.documentMessage)) {
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

    const msgId = msg.key?.id;
    if (!msgId) return;

    const mediaPath = path.join(MEDIA_DIR, `${msgId}.bin`);
    const metadataPath = path.join(MEDIA_DIR, `${msgId}.meta.json`);

    if (fs.existsSync(mediaPath)) return;

    const mediaObj = unwrapped.imageMessage || unwrapped.videoMessage || unwrapped.audioMessage || unwrapped.stickerMessage || unwrapped.documentMessage;
    if (!hasValidMediaKey(mediaObj)) return;

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

    if (buffer && buffer.length > 0) {
      fs.writeFileSync(mediaPath, buffer);
      fs.writeFileSync(metadataPath, JSON.stringify(mediaDetails, null, 2));
      console.log(`[AntiDelete] Successfully cached media for message ${msgId}`);
    }
  } catch (err: any) {
    if (err?.message?.includes('empty media key') || err?.message?.includes('mediaKey')) {
      // Quietly ignore messages with empty or missing media key
      return;
    }
    console.error(`[AntiDelete] Failed to save media for message ${msg.key?.id}:`, err?.message || err);
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

// Normalize JID removing device identifiers (e.g., :12@) and normalizing server
export function normalizeJid(jid: string): string {
  if (!jid) return '';
  const cleaned = cleanJid(jid);
  return cleaned.replace(/:\d+@/, '@').trim().toLowerCase();
}

// Extract pure phone number or digits from a JID if applicable
export function extractPhoneNumber(jid: string): string {
  if (!jid) return '';
  const parts = jid.split('@');
  if (parts.length === 0) return '';
  const userPart = parts[0].split(':')[0];
  const digits = userPart.replace(/\D/g, '');
  return digits;
}

// Helper to find a participant in a group by JID, LID, or phone number
export function findParticipant(participants: any[], targetJid: string): any {
  if (!Array.isArray(participants) || !targetJid) return null;
  const targetNorm = normalizeJid(targetJid);
  const targetPhone = extractPhoneNumber(targetJid);

  return participants.find((p: any) => {
    const pId = normalizeJid(p.id);
    const pJid = normalizeJid(p.jid);
    const pLid = normalizeJid(p.lid);
    const pPhone = normalizeJid(p.phoneNumber);
    const pDigits = extractPhoneNumber(p.id || p.jid || p.phoneNumber || '');

    if (pId && pId === targetNorm) return true;
    if (pJid && pJid === targetNorm) return true;
    if (pLid && pLid === targetNorm) return true;
    if (pPhone && pPhone === targetNorm) return true;
    if (targetPhone && pDigits && targetPhone === pDigits) return true;
    return false;
  });
}

// Get the actual sender JID, accounting for fromMe messages (sent by the bot/owner)
export function getSenderJid(msg: any, ownerJid: string): string {
  if (msg.key?.fromMe) {
    return ownerJid;
  }
  const rawJid = msg.key?.participant || msg.key?.remoteJid || '';
  return cleanJid(rawJid);
}

// Helper to check group permissions and fetch group metadata
export async function getGroupPermissions(sock: any, chatJid: string, senderJid: string, isFromMe: boolean) {
  if (!chatJid || !chatJid.endsWith('@g.us')) {
    return { isGroup: false, isBotAdmin: false, isUserAdmin: false, metadata: null, participants: [], botJid: '', cleanSender: cleanJid(senderJid) };
  }

  let metadata: any = null;

  // 1. Always fetch fresh group metadata from WhatsApp servers to avoid stale cache
  try {
    metadata = await sock.groupMetadata(chatJid);
  } catch (err) {
    // Retry once in case of transient network glitch
    try {
      await new Promise(r => setTimeout(r, 200));
      metadata = await sock.groupMetadata(chatJid);
    } catch (retryErr) {
      console.error('[Group Metadata Error] Failed to fetch group metadata for JID:', chatJid, retryErr);
    }
  }

  const participants: any[] = metadata?.participants || [];

  // 2. Extract bot JID variations (PN and LID)
  const botRawId = sock.user?.id || sock.user?.jid || '';
  const botRawLid = sock.user?.lid || '';

  const botJidPN = normalizeJid(botRawId);       // e.g. 923001234567@s.whatsapp.net
  const botJidLID = normalizeJid(botRawLid);     // e.g. 109823871239812@lid
  const botPhone = extractPhoneNumber(botRawId); // e.g. 923001234567
  const botLidUser = botJidLID ? botJidLID.split('@')[0] : '';

  // Primary bot JID for return
  const botJid = botJidPN || botJidLID || cleanJid(botRawId);

  // 3. Extract sender JID variations
  const cleanSender = cleanJid(senderJid);
  const senderNorm = normalizeJid(senderJid);
  const senderPhone = extractPhoneNumber(senderJid);

  // 4. Find bot participant in group metadata using flexible multi-field matching
  const botParticipant = participants.find((p: any) => {
    const pId = normalizeJid(p.id);
    const pJid = normalizeJid(p.jid);
    const pLid = normalizeJid(p.lid);
    const pPhone = normalizeJid(p.phoneNumber);
    const pDigits = extractPhoneNumber(p.id || p.jid || p.phoneNumber || '');

    if (botJidPN && (pId === botJidPN || pJid === botJidPN || pPhone === botJidPN)) return true;
    if (botJidLID && (pId === botJidLID || pJid === botJidLID || pLid === botJidLID)) return true;
    if (botPhone && pDigits && botPhone === pDigits) return true;
    if (botLidUser && (p.id?.includes(botLidUser) || p.lid?.includes(botLidUser) || p.user === botLidUser)) return true;
    return false;
  });

  // 5. Check if bot is admin or owner
  let isBotAdmin = false;
  if (botParticipant) {
    const role = botParticipant.admin;
    isBotAdmin = role === 'admin' || role === 'superadmin' || role === 'true' || role === true || (botParticipant as any).isAdmin === true;
  }

  // Backup owner check for bot
  if (!isBotAdmin && metadata?.owner) {
    const ownerNorm = normalizeJid(metadata.owner);
    const ownerPhone = extractPhoneNumber(metadata.owner);
    if ((botJidPN && ownerNorm === botJidPN) || (botJidLID && ownerNorm === botJidLID) || (botPhone && ownerPhone && botPhone === ownerPhone)) {
      isBotAdmin = true;
    }
  }

  // 6. Find sender participant in group metadata
  const senderParticipant = participants.find((p: any) => {
    const pId = normalizeJid(p.id);
    const pJid = normalizeJid(p.jid);
    const pLid = normalizeJid(p.lid);
    const pPhone = normalizeJid(p.phoneNumber);
    const pDigits = extractPhoneNumber(p.id || p.jid || p.phoneNumber || '');

    if (senderNorm && (pId === senderNorm || pJid === senderNorm || pLid === senderNorm || pPhone === senderNorm)) return true;
    if (senderPhone && pDigits && senderPhone === pDigits) return true;
    return false;
  });

  // 7. Check if sender is admin or owner or if message is fromMe (bot/owner)
  let isUserAdmin = isFromMe;
  if (!isUserAdmin && senderParticipant) {
    const role = senderParticipant.admin;
    isUserAdmin = role === 'admin' || role === 'superadmin' || role === 'true' || role === true || (senderParticipant as any).isAdmin === true;
  }

  if (!isUserAdmin && metadata?.owner) {
    const ownerNorm = normalizeJid(metadata.owner);
    const ownerPhone = extractPhoneNumber(metadata.owner);
    if ((senderNorm && ownerNorm === senderNorm) || (senderPhone && ownerPhone && senderPhone === ownerPhone)) {
      isUserAdmin = true;
    }
  }

  // 8. Output internal debug logs (not visible to users)
  console.log('[Group Permissions Check]', {
    groupId: chatJid,
    botJidPN,
    botJidLID,
    senderJid: cleanSender,
    isFromMe,
    totalParticipants: participants.length,
    groupOwner: metadata?.owner || 'Unknown',
    botParticipantFound: !!botParticipant,
    botAdminRole: botParticipant?.admin || (isBotAdmin ? 'superadmin (owner)' : null),
    isBotAdmin,
    senderParticipantFound: !!senderParticipant,
    senderAdminRole: senderParticipant?.admin || (isUserAdmin ? 'superadmin/fromMe' : null),
    isUserAdmin,
    permissionResult: {
      isGroup: true,
      isBotAdmin,
      isUserAdmin
    }
  });

  return {
    isGroup: true,
    isBotAdmin,
    isUserAdmin,
    metadata,
    participants,
    botJid,
    cleanSender
  };
}

// Helper to extract target user JIDs from mentions, quoted message, or phone numbers in arguments
export function extractTargetJids(msg: any, args: string[]): string[] {
  const targets = new Set<string>();

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                      msg.message?.imageMessage?.contextInfo || 
                      msg.message?.videoMessage?.contextInfo || 
                      msg.message?.documentMessage?.contextInfo;

  // 1. Mentioned JIDs
  if (contextInfo?.mentionedJid && Array.isArray(contextInfo.mentionedJid)) {
    for (const jid of contextInfo.mentionedJid) {
      if (jid) targets.add(cleanJid(jid));
    }
  }

  // 2. Quoted / Replied message participant
  if (contextInfo?.participant) {
    targets.add(cleanJid(contextInfo.participant));
  }

  // 3. Phone numbers passed in args
  for (const arg of args) {
    const cleanNum = arg.replace(/[^0-9]/g, '');
    if (cleanNum.length >= 7 && cleanNum.length <= 15) {
      targets.add(`${cleanNum}@s.whatsapp.net`);
    }
  }

  return Array.from(targets);
}

// Helper to parse duration (10m, 1h, 12h, 7d) and reason from args
export function parseDurationMs(args: string[], targets: string[]): { durationMs: number | null; displayStr: string; reason: string } {
  const cleanArgs = args.filter(arg => {
    if (arg.startsWith('@')) return false;
    const digits = arg.replace(/[^0-9]/g, '');
    if (digits.length >= 7 && targets.some(t => t.startsWith(digits))) return false;
    return true;
  });

  if (cleanArgs.length === 0) {
    return { durationMs: null, displayStr: 'Permanent', reason: 'No reason specified' };
  }

  const firstToken = cleanArgs[0];
  const durationMatch = firstToken.match(/^(\d+)([smhd])$/i);

  if (durationMatch) {
    const num = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();

    let durationMs: number | null = null;
    let displayStr = 'Permanent';

    if (unit === 's') {
      durationMs = num * 1000;
      displayStr = `${num} Second${num > 1 ? 's' : ''}`;
    } else if (unit === 'm') {
      durationMs = num * 60 * 1000;
      displayStr = `${num} Minute${num > 1 ? 's' : ''}`;
    } else if (unit === 'h') {
      durationMs = num * 3600 * 1000;
      displayStr = `${num} Hour${num > 1 ? 's' : ''}`;
    } else if (unit === 'd') {
      durationMs = num * 86400 * 1000;
      displayStr = `${num} Day${num > 1 ? 's' : ''}`;
    }

    const reason = cleanArgs.slice(1).join(' ').trim() || 'No reason specified';
    return { durationMs, displayStr, reason };
  }

  const reason = cleanArgs.join(' ').trim() || 'No reason specified';
  return { durationMs: null, displayStr: 'Permanent', reason };
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

  let notificationText = createBox('🗑️ 𝗔𝗡𝗧𝗜-𝗗𝗘𝗟𝗘𝗧𝗘',
`• 👤 Sender: @${senderNumber}
• 💬 Chat: ${found.chatName}
• ⏰ Time: ${timeStr}

• 📝 Message: ${originalText}`
  );

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
          text: createBox('⚙️ 𝗦𝗬𝗦𝗧𝗘𝗠', `• ⚙️ Current Mode: ${capitalizedMode}\n• 📌 Info: Use .mode public or .mode private`) 
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
          text: createBox('⚙️ 𝗦𝗬𝗦𝗧𝗘𝗠', `• 🛡️ Anti-Delete: ${isEnabled ? 'Enabled ✅' : 'Disabled ❌'}\n• 📌 Info: Use .antidelete on|off`)
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

      const statusMsg = createBox('🤖 𝗛𝗜𝗝𝗝𝗔𝗭𝗘 𝗕𝗢𝗧',
`• 🟢 Status: Online
• ⚙️ Mode: ${capitalizedMode}
• 🛡️ Anti-Delete: ${isAntiDeleteOn ? 'Enabled' : 'Disabled'}
• ⏱️ Uptime: ${uptimeStr}
• 📱 Account: +${ownNumber}`
      );

      await sock.sendMessage(chatJid, { text: statusMsg }, { quoted: msg });
    }
  },
  {
    name: 'menu',
    aliases: ['help', 'dashboard', 'cmds', 'commands'],
    category: '🌐 GENERAL',
    description: 'Displays the premium WhatsApp command dashboard',
    usage: '.menu',
    handler: async (ctx) => {
      const { sock, msg, chatJid, userId } = ctx;
      
      const { dateStr, timeStr } = getFormattedDateTime();
      const uptimeStr = formatUptime(Date.now() - serverStartTime);
      const totalCmds = commands.length;
      const currentMode = getBotMode(userId).toUpperCase();

      // Header Box
      const headerBox = `╔════════════════════════════╗
┃ 🤖 ${toBoldSans('HIJJAZE BOT DASHBOARD')}
╠════════════════════════════╣
┃ 👑 Creator : Kashfurrahman Kashaf Hijjaze
┃ 📺 YouTube : Kashfurrahman Kashaf Hijjaze
┃ ⚡ Version : v7.2.1-MD
┃ ⏱ Runtime : ${uptimeStr}
┃ 📅 Date    : ${dateStr}
┃ 🕒 Time    : ${timeStr}
┃ 🌍 Mode    : ${currentMode}
┃ 🟢 Status  : ONLINE
┃ 📌 Prefix  : .
┃ 📊 Commands : ${totalCmds}
╚════════════════════════════╝`;

      // Group commands dynamically by category title
      const categoryMap = new Map<string, string[]>();

      const categoryOrder = [
        `🤖 ${toBoldSans('AI COMMANDS')}`,
        `🌐 ${toBoldSans('GENERAL COMMANDS')}`,
        `👑 ${toBoldSans('OWNER COMMANDS')}`,
        `👮 ${toBoldSans('ADMIN COMMANDS')}`,
        `👥 ${toBoldSans('GROUP COMMANDS')}`,
        `🎵 ${toBoldSans('DOWNLOAD COMMANDS')}`,
        `🎨 ${toBoldSans('STICKER COMMANDS')}`,
        `🎨 ${toBoldSans('IMAGE COMMANDS')}`,
        `🛠️ ${toBoldSans('UTILITY COMMANDS')}`,
        `🔧 ${toBoldSans('TOOLS')}`,
        `🎮 ${toBoldSans('FUN COMMANDS')}`,
        `🕌 ${toBoldSans('ISLAMIC COMMANDS')}`,
        `📚 ${toBoldSans('INFORMATION COMMANDS')}`,
        `⚙️ ${toBoldSans('SYSTEM COMMANDS')}`,
        `⭐ ${toBoldSans('PREMIUM COMMANDS')}`
      ];

      for (const cmd of commands) {
        const catTitle = getDisplayCategoryTitle(cmd);
        if (!categoryMap.has(catTitle)) {
          categoryMap.set(catTitle, []);
        }
        categoryMap.get(catTitle)!.push(cmd.name);
      }

      // Build Category Boxes
      const categoryBoxes: string[] = [];

      const sortedCategories = Array.from(categoryMap.keys()).sort((a, b) => {
        const idxA = categoryOrder.indexOf(a);
        const idxB = categoryOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });

      for (const catTitle of sortedCategories) {
        const cmdList = categoryMap.get(catTitle);
        if (!cmdList || cmdList.length === 0) continue;

        // Deduplicate and sort command names alphabetically
        const uniqueCmds = Array.from(new Set(cmdList)).sort();
        const cmdLines = uniqueCmds.map(c => `┃ ➤ .${c}`).join('\n');

        const box = `╔════════════════════════════╗
┃ ${catTitle}
╠════════════════════════════╣
${cmdLines}
╚════════════════════════════╝`;

        categoryBoxes.push(box);
      }

      // Footer Box
      const footerBox = `╔════════════════════════════╗
┃ ✨ Thank you for using
┃ 🤖 𝗛𝗜𝗝𝗝𝗔𝗭𝗘 𝗕𝗢𝗧
┃
┃ 👑 Created by:
┃ Kashfurrahman Kashaf Hijjaze
┃
┃ 🚀 Fast • Secure • Powerful
╚════════════════════════════╝`;

      const fullMenu = [headerBox, ...categoryBoxes, footerBox].join('\n\n');

      await sock.sendMessage(chatJid, { text: fullMenu }, { quoted: msg });
    }
  },
  {
    name: 'owner',
    aliases: ['creator'],
    category: '🌐 GENERAL',
    description: 'Displays information about the bot creator',
    usage: '.owner',
    handler: async (ctx) => {
      const { sock, msg, chatJid } = ctx;
      const ownerBox = createBox('👑 𝗕𝗢𝗧 𝗢𝗪𝗡𝗘𝗥',
`• 👤 Name: Kashfurrahman Kashaf Hijjaze
• 📺 YouTube: Kashfurrahman Kashaf Hijjaze
• 🤖 Bot: Hijjaze Bot v7.2.1-MD
• 📢 Channel: https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y`
      );
      await sock.sendMessage(chatJid, { text: ownerBox }, { quoted: msg });
    }
  },
  {
    name: 'jid',
    category: '🌐 GENERAL',
    description: 'Get current chat or user JID',
    usage: '.jid',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid } = ctx;
      const jidBox = createBox('🆔 𝗝𝗜𝗗 𝗜𝗡𝗙𝗢',
`• 💬 Chat JID: ${chatJid}
• 👤 Sender JID: ${senderJid}`
      );
      await sock.sendMessage(chatJid, { text: jidBox }, { quoted: msg });
    }
  },
  {
    name: 'url',
    category: '🌐 GENERAL',
    description: 'Displays official channel and website links',
    usage: '.url',
    handler: async (ctx) => {
      const { sock, msg, chatJid } = ctx;
      const channelConfig = getChannelConfig();
      const urlBox = createBox('🔗 𝗢𝗙𝗙𝗜𝗖𝗜𝗔𝗟 𝗟𝗜𝗡𝗞𝗦',
`• 📢 Channel: ${channelConfig.link || 'https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y'}
• 👑 Creator: Kashfurrahman Kashaf Hijjaze`
      );
      await sock.sendMessage(chatJid, { text: urlBox }, { quoted: msg });
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
      const tempMsg = await sock.sendMessage(chatJid, { text: createBox('⚡ 𝗣𝗜𝗡𝗚', '• ⏱️ Measuring latency...') }, { quoted: msg });
      const latency = Date.now() - start;
      try {
        await sock.sendMessage(chatJid, { 
          text: createBox('⚡ 𝗣𝗜𝗡𝗚', `• 🏓 Pong!\n• ⏱️ Latency: ${latency}ms`),
          edit: tempMsg.key
        });
      } catch (e) {
        // Fallback if edit fails
        await sock.sendMessage(chatJid, { 
          text: createBox('⚡ 𝗣𝗜𝗡𝗚', `• 🏓 Pong!\n• ⏱️ Latency: ${latency}ms`)
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
      
      const statsText = createBox('📊 𝗦𝗘𝗦𝗦𝗜𝗢𝗡 𝗦𝗧𝗔𝗧𝗦',
`• 📱 Device: +${ownNumber}
• 📨 Processed: ${msgsProcessed} msgs
• 🖥️ Node: ${process.version}
• 🔄 Platform: Linux`
      );

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
        const formattedJoke = createBox('🤣 𝗥𝗔𝗡𝗗𝗢𝗠 𝗝𝗢𝗞𝗘',
`• 🎭 Setup: ${jokeObj.setup}
• 😄 Punchline: ${jokeObj.punchline}
• 💡 Info: ${jokeObj.explanation}`
        );

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
        const formattedFact = createBox('🧠 𝗔𝗠𝗔𝗭𝗜𝗡𝗚 𝗙𝗔𝗖𝗧',
`• 📌 Fact: ${factObj.fact}
• 📖 Info: ${factObj.explanation}`
        );

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
        const formattedResponse = createBox('🤖 𝗛𝗜𝗝𝗝𝗔𝗭𝗘 𝗚𝗣𝗧',
`• 💬 Prompt: ${promptText}

• 🧠 Answer:
${aiResponse}`
        );

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
  },
  {
    name: 'imagine',
    aliases: ['image', 'img', 'draw', 'gen'],
    category: '🎨 IMAGE',
    description: 'Generates ultra-HD realistic AI images from any prompt or emoji',
    usage: '.imagine [description/emoji] or reply to a message with .imagine',
    handler: async (ctx) => {
      const { sock, msg, chatJid, args } = ctx;

      // Extract prompt text from args or replied/quoted message
      let promptText = args.join(' ').trim();

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                          msg.message?.imageMessage?.contextInfo || 
                          msg.message?.videoMessage?.contextInfo || 
                          msg.message?.documentMessage?.contextInfo;

      if (contextInfo?.quotedMessage) {
        const unwrappedQuoted = unwrapMessage(contextInfo.quotedMessage);
        if (unwrappedQuoted) {
          const quotedText = unwrappedQuoted.conversation ||
                             unwrappedQuoted.extendedTextMessage?.text ||
                             unwrappedQuoted.imageMessage?.caption ||
                             unwrappedQuoted.videoMessage?.caption ||
                             unwrappedQuoted.documentMessage?.caption || '';
          if (quotedText && !promptText) {
            promptText = quotedText.trim();
          }
        }
      }

      // If no prompt text provided
      if (!promptText) {
        await sock.sendMessage(chatJid, { text: '❌ Please describe the image you want to generate.' }, { quoted: msg });
        return;
      }

      // Presence update
      try {
        await sock.sendPresenceUpdate('composing', chatJid);
      } catch (err) {
        // Ignored
      }

      try {
        const { buffer } = await generateImageBuffer(promptText);

        const captionText = createBox('🎨 𝗜𝗠𝗔𝗚𝗜𝗡𝗘',
`• 📝 Prompt: ${promptText}
• ✨ Generated by Hijjaze Bot AI`
        );

        await sock.sendMessage(chatJid, {
          image: buffer,
          caption: captionText
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[Imagine] Error generating image:', err);
        const errMessage = err?.message || '';

        if (errMessage.includes('unavailable') || errMessage.includes('API Key')) {
          await sock.sendMessage(chatJid, { text: '❌ The image generation service is temporarily unavailable.' }, { quoted: msg });
        } else {
          await sock.sendMessage(chatJid, { text: '❌ Unable to generate your image at the moment. Please try again later.' }, { quoted: msg });
        }
      } finally {
        try {
          await sock.sendPresenceUpdate('paused', chatJid);
        } catch (err) {
          // Ignored
        }
      }
    }
  },
  {
    name: 'channel',
    aliases: ['setchannel', 'ch'],
    category: '⚙️ SYSTEM',
    description: 'View or update the official WhatsApp Channel configuration',
    usage: '.channel or .channel [name|link|jid] [value]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, args } = ctx;
      const ownerJid = cleanJid(sock.user?.id || '');
      const isOwner = msg.key.fromMe || ctx.senderJid === ownerJid;

      let config = getChannelConfig();

      if (args.length >= 2 && isOwner) {
        const field = args[0].toLowerCase();
        const value = args.slice(1).join(' ').trim();

        if (field === 'name') {
          config = setChannelConfig({ name: value });
          await sock.sendMessage(chatJid, { text: `✅ Updated Channel Name to: *${config.name}*` }, { quoted: msg });
          return;
        } else if (field === 'link' || field === 'url') {
          config = setChannelConfig({ link: value });
          await sock.sendMessage(chatJid, { text: `✅ Updated Channel Link to: *${config.link}*` }, { quoted: msg });
          return;
        } else if (field === 'jid' || field === 'newsletter') {
          config = setChannelConfig({ newsletterJid: value.includes('@newsletter') ? value : `${value}@newsletter` });
          await sock.sendMessage(chatJid, { text: `✅ Updated Newsletter JID to: *${config.newsletterJid}*` }, { quoted: msg });
          return;
        }
      }

      const infoText = createBox('📢 𝗖𝗛𝗔𝗡𝗡𝗘𝗟 𝗖𝗢𝗡𝗙𝗜𝗚',
`• 📌 Name: ${config.name}
• 🔗 Link: ${config.link}
• 🆔 JID: ${config.newsletterJid}`
      );

      await sock.sendMessage(chatJid, { text: infoText }, { quoted: msg });
    }
  },
  {
    name: 'kick',
    aliases: ['remove', 'removemember', 'ban'],
    category: '👥 GROUP',
    description: 'Remove mentioned member(s) or replied user from the group',
    usage: '.kick @user or reply to a message with .kick',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can use this command.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to kick members.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention member(s) or reply to a user\'s message to kick.\n\nUsage: `.kick @user`' }, { quoted: msg });
        return;
      }

      const validTargets: string[] = [];
      const skipped: string[] = [];

      for (const target of targets) {
        if (target === perm.botJid) {
          skipped.push('The bot itself cannot be kicked.');
          continue;
        }
        const participant = findParticipant(perm.participants, target);
        if (!participant) {
          skipped.push(`User @${target.split('@')[0]} is not in this group.`);
          continue;
        }
        if (participant.admin === 'superadmin') {
          skipped.push(`Cannot kick group owner @${target.split('@')[0]}.`);
          continue;
        }
        const actualJid = cleanJid(participant.id || participant.jid || target);
        if (actualJid) validTargets.push(actualJid);
      }

      const uniqueTargets = Array.from(new Set(validTargets));

      if (uniqueTargets.length === 0) {
        const errorMsg = skipped.length > 0 ? `❌ Cannot kick specified user(s):\n• ${skipped.join('\n• ')}` : '❌ No valid users found to kick.';
        await sock.sendMessage(chatJid, { text: errorMsg }, { quoted: msg });
        return;
      }

      try {
        await sock.groupParticipantsUpdate(chatJid, uniqueTargets, 'remove');
        
        const mentionsList = uniqueTargets.map(t => `• @${t.split('@')[0]}`).join('\n');
        const successBox = createBox('👮 𝗚𝗥𝗢𝗨𝗣 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧',
`• 📊 Status: Success
• 👤 Removed Member(s):
${mentionsList}`
        );

        await sock.sendMessage(chatJid, { 
          text: successBox, 
          mentions: uniqueTargets 
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[Kick] Failed to remove participants:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to remove member(s). Error: ${err.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'add',
    aliases: ['addmember', 'invite'],
    category: '👥 GROUP',
    description: 'Add member(s) to the group using phone number(s)',
    usage: '.add 923001234567',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can use this command.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to add members.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please specify phone number(s) to add.\n\nUsage: `.add 923001234567`' }, { quoted: msg });
        return;
      }

      const newTargets = targets.filter(t => !findParticipant(perm.participants, t));

      if (newTargets.length === 0) {
        await sock.sendMessage(chatJid, { text: '⚠️ Specified user(s) are already in this group.' }, { quoted: msg });
        return;
      }

      try {
        const response = await sock.groupParticipantsUpdate(chatJid, newTargets, 'add');
        
        let addedList: string[] = [];
        let failedPrivacy: string[] = [];

        if (Array.isArray(response)) {
          for (const item of response) {
            const jid = item.jid || item.user;
            const status = String(item.status || item.code || '');
            if (status === '200' || status === '0') {
              addedList.push(cleanJid(jid));
            } else if (status === '403' || status === '408') {
              failedPrivacy.push(cleanJid(jid));
            }
          }
        } else {
          addedList = newTargets;
        }

        let reportBody = '• 📊 Status: Success\n';
        if (addedList.length > 0) {
          reportBody += `• ✅ Added:\n${addedList.map(t => `  └ @${t.split('@')[0]}`).join('\n')}\n`;
        }
        if (failedPrivacy.length > 0) {
          reportBody += `• ⚠️ Privacy restriction:\n${failedPrivacy.map(t => `  └ @${t.split('@')[0]}`).join('\n')}\n`;
        }
        const reportText = createBox('👥 𝗚𝗥𝗢𝗨𝗣 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧', reportBody);

        await sock.sendMessage(chatJid, { 
          text: reportText.trim(), 
          mentions: [...addedList, ...failedPrivacy] 
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[Add] Failed to add participants:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to add member(s). Error: ${err.message || 'WhatsApp operation failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'promote',
    aliases: ['admin', 'makeadmin'],
    category: '👥 GROUP',
    description: 'Promote mentioned member(s) to group admin',
    usage: '.promote @user or reply to a message with .promote',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can use this command.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to promote members.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention member(s) or reply to a message to promote.\n\nUsage: `.promote @user`' }, { quoted: msg });
        return;
      }

      const toPromote: string[] = [];
      const alreadyAdmins: string[] = [];

      for (const t of targets) {
        const participant = findParticipant(perm.participants, t);
        if (!participant) continue;
        const actualJid = cleanJid(participant.id || participant.jid || t);
        if (participant.admin === 'admin' || participant.admin === 'superadmin') {
          alreadyAdmins.push(actualJid);
        } else {
          toPromote.push(actualJid);
        }
      }

      const uniquePromote = Array.from(new Set(toPromote));

      if (uniquePromote.length === 0) {
        const msgStr = alreadyAdmins.length > 0 ? '⚠️ Specified user(s) are already group admins.' : '❌ No valid users found to promote.';
        await sock.sendMessage(chatJid, { text: msgStr }, { quoted: msg });
        return;
      }

      try {
        await sock.groupParticipantsUpdate(chatJid, uniquePromote, 'promote');

        const mentionsList = uniquePromote.map(t => `• @${t.split('@')[0]}`).join('\n');
        const successBox = createBox('👮 𝗚𝗥𝗢𝗨𝗣 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧',
`• 📊 Status: Success
• 🛡️ Promoted to Admin:
${mentionsList}`
        );

        await sock.sendMessage(chatJid, { 
          text: successBox, 
          mentions: uniquePromote 
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[Promote] Failed to promote participants:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to promote member(s). Error: ${err.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'demote',
    aliases: ['unadmin', 'removeadmin'],
    category: '👥 GROUP',
    description: 'Demote mentioned admin(s) back to regular members',
    usage: '.demote @user or reply to a message with .demote',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can use this command.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to demote admins.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention admin(s) or reply to a message to demote.\n\nUsage: `.demote @user`' }, { quoted: msg });
        return;
      }

      const toDemote: string[] = [];
      const notAdmins: string[] = [];
      const superAdmins: string[] = [];

      for (const t of targets) {
        const participant = findParticipant(perm.participants, t);
        if (!participant) continue;
        const actualJid = cleanJid(participant.id || participant.jid || t);
        if (participant.admin === 'superadmin') {
          superAdmins.push(actualJid);
        } else if (participant.admin === 'admin') {
          toDemote.push(actualJid);
        } else {
          notAdmins.push(actualJid);
        }
      }

      const uniqueDemote = Array.from(new Set(toDemote));

      if (uniqueDemote.length === 0) {
        let errStr = '❌ No valid admins found to demote.';
        if (superAdmins.length > 0) errStr = '❌ Cannot demote the Group Owner.';
        else if (notAdmins.length > 0) errStr = '⚠️ Specified user(s) are not admins.';
        await sock.sendMessage(chatJid, { text: errStr }, { quoted: msg });
        return;
      }

      try {
        await sock.groupParticipantsUpdate(chatJid, uniqueDemote, 'demote');

        const mentionsList = uniqueDemote.map(t => `• @${t.split('@')[0]}`).join('\n');
        const successBox = createBox('👮 𝗚𝗥𝗢𝗨𝗣 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧',
`• 📊 Status: Success
• 👤 Demoted to Member:
${mentionsList}`
        );

        await sock.sendMessage(chatJid, { 
          text: successBox, 
          mentions: uniqueDemote 
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[Demote] Failed to demote participants:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to demote admin(s). Error: ${err.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'tagall',
    aliases: ['everyone', 'all', 'mentionall'],
    category: '👥 GROUP',
    description: 'Mention every member in the group with an optional custom message',
    usage: '.tagall [custom message]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can use this command.' }, { quoted: msg });
        return;
      }

      let announcementText = args.join(' ').trim();
      if (!announcementText) {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (contextInfo?.quotedMessage) {
          const unwrapped = unwrapMessage(contextInfo.quotedMessage);
          announcementText = unwrapped?.conversation || unwrapped?.extendedTextMessage?.text || unwrapped?.imageMessage?.caption || unwrapped?.videoMessage?.caption || '';
        }
      }

      if (!announcementText) {
        announcementText = 'Attention Everyone!';
      }

      const participantJids = perm.participants.map((p: any) => cleanJid(p.id));
      const mentionsFormatted = participantJids.map(jid => `@${jid.split('@')[0]}`).join(' ');

      const tagText = createBox('📢 𝗔𝗡𝗡𝗢𝗨𝗡𝗖𝗘𝗠𝗘𝗡𝗧',
`• 📝 ${announcementText}
• 👥 Members (${participantJids.length}): ${mentionsFormatted}`
      );

      await sock.sendMessage(chatJid, {
        text: tagText,
        mentions: participantJids
      }, { quoted: msg });
    }
  },
  {
    name: 'hidetag',
    aliases: ['htag', 'notify'],
    category: '👥 GROUP',
    description: 'Send a message that silently mentions every member without displaying the mention list',
    usage: '.hidetag [message] or reply to a message/media with .hidetag',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can use this command.' }, { quoted: msg });
        return;
      }

      const participantJids = perm.participants.map((p: any) => cleanJid(p.id));
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
      let textMessage = args.join(' ').trim();

      if (contextInfo?.quotedMessage) {
        const quotedMsg = contextInfo.quotedMessage;
        try {
          const sendOpts: any = {
            mentions: participantJids
          };

          if (textMessage) {
            await sock.sendMessage(chatJid, { text: textMessage, mentions: participantJids }, { quoted: msg });
          } else if (typeof sock.copyNForward === 'function') {
            await sock.copyNForward(chatJid, { key: { remoteJid: chatJid, id: contextInfo.stanzaId }, message: quotedMsg }, false, sendOpts);
          } else {
            await sock.sendMessage(chatJid, { forward: { key: { remoteJid: chatJid, id: contextInfo.stanzaId }, message: quotedMsg }, mentions: participantJids });
          }
          return;
        } catch (err) {
          console.error('[Hidetag] Failed to forward quoted message with hidetag:', err);
        }
      }

      if (!textMessage) {
        textMessage = '🔔 Notification for all group members!';
      }

      await sock.sendMessage(chatJid, {
        text: textMessage,
        mentions: participantJids
      }, { quoted: msg });
    }
  },
  {
    name: 'admins',
    aliases: ['adminlist', 'listadmins'],
    category: '👥 GROUP',
    description: 'Display all admins and owner of the group',
    usage: '.admins',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }

      const superAdmins: string[] = [];
      const regularAdmins: string[] = [];
      const allAdminJids: string[] = [];

      for (const p of perm.participants) {
        const jid = cleanJid(p.id);
        if (p.admin === 'superadmin') {
          superAdmins.push(jid);
          allAdminJids.push(jid);
        } else if (p.admin === 'admin') {
          regularAdmins.push(jid);
          allAdminJids.push(jid);
        }
      }

      const ownerStr = superAdmins.length > 0 
        ? superAdmins.map(jid => `@${jid.split('@')[0]}`).join(', ') 
        : 'Creator';

      const adminStr = regularAdmins.length > 0 
        ? regularAdmins.map(jid => `@${jid.split('@')[0]}`).join(', ') 
        : 'None';

      const totalAdmins = allAdminJids.length;

      const text = createBox('👮 𝗚𝗥𝗢𝗨𝗣 𝗔𝗗𝗠𝗜𝗡𝗦',
`• 👑 Owner: ${ownerStr}
• 🛡️ Admins (${regularAdmins.length}): ${adminStr}
• 📊 Total Admins: ${totalAdmins}`
      );

      await sock.sendMessage(chatJid, {
        text,
        mentions: allAdminJids
      }, { quoted: msg });
    }
  },
  {
    name: 'members',
    aliases: ['memberlist', 'listmembers', 'groupinfo'],
    category: '👥 GROUP',
    description: 'Display group metadata, total member count, admin count, and participant list',
    usage: '.members',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }

      const totalCount = perm.participants.length;
      let adminCount = 0;
      let memberCount = 0;

      const allJids: string[] = [];
      const memberLines: string[] = [];

      for (const p of perm.participants) {
        const jid = cleanJid(p.id);
        allJids.push(jid);

        let roleTag = '';
        if (p.admin === 'superadmin') {
          roleTag = ' 👑 [Owner]';
          adminCount++;
        } else if (p.admin === 'admin') {
          roleTag = ' 🛡️ [Admin]';
          adminCount++;
        } else {
          memberCount++;
        }

        memberLines.push(`• @${jid.split('@')[0]}${roleTag}`);
      }

      let listFormatted = '';
      if (totalCount > 100) {
        listFormatted = memberLines.slice(0, 50).join('\n') + `\n\n_...and ${totalCount - 50} more members._`;
      } else {
        listFormatted = memberLines.join('\n');
      }

      const text = createBox('👥 𝗚𝗥𝗢𝗨𝗣 𝗠𝗘𝗠𝗕𝗘𝗥𝗦',
`• 📌 Group: ${perm.metadata?.subject || 'Group'}
• 📊 Members: ${totalCount} (${adminCount} Admins, ${memberCount} Regular)
• 📋 Participants: ${allJids.slice(0, 30).map(j => `@${j.split('@')[0]}`).join(' ')}${totalCount > 30 ? '...' : ''}`
      );

      await sock.sendMessage(chatJid, {
        text,
        mentions: allJids.slice(0, 100)
      }, { quoted: msg });
    }
  },
  {
    name: 'setname',
    aliases: ['setsubject', 'changename', 'groupname'],
    category: '👥 GROUP',
    description: 'Change the group name (subject)',
    usage: '.setname [New Group Name]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can change group settings.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to change group settings.' }, { quoted: msg });
        return;
      }

      const newName = args.join(' ').trim();
      if (!newName) {
        await sock.sendMessage(chatJid, { text: '❌ Please specify the new group name.\n\nUsage: `.setname Hijjaze Community`' }, { quoted: msg });
        return;
      }

      if (newName.length > 100) {
        await sock.sendMessage(chatJid, { text: '❌ Group name is too long. Maximum allowed length is 100 characters.' }, { quoted: msg });
        return;
      }

      const oldName = perm.metadata?.subject || 'Group';

      try {
        await sock.groupUpdateSubject(chatJid, newName);
        
        const { timeStr } = getFormattedDateTime();
        const senderNum = perm.cleanSender.split('@')[0];

        const successBox = createBox('🏘️ 𝗚𝗥𝗢𝗨𝗣 𝗦𝗘𝗧𝗧𝗜𝗡𝗚𝗦',
`• 📊 Status: Group Name Updated
• 📝 Previous: ${oldName}
• ✨ New Name: ${newName}
• 👤 By: @${senderNum} • ⏰ Time: ${timeStr}`
        );

        await sock.sendMessage(chatJid, {
          text: successBox,
          mentions: [perm.cleanSender]
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[SetName] Error updating subject:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to update group name. Error: ${err?.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'setdesc',
    aliases: ['setdescription', 'updatedesc', 'groupdesc'],
    category: '👥 GROUP',
    description: 'Update the group description',
    usage: '.setdesc [New Group Description]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can change group settings.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to change group description.' }, { quoted: msg });
        return;
      }

      let newDesc = args.join(' ').trim();
      if (!newDesc) {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (contextInfo?.quotedMessage) {
          const unwrapped = unwrapMessage(contextInfo.quotedMessage);
          newDesc = unwrapped?.conversation || unwrapped?.extendedTextMessage?.text || unwrapped?.imageMessage?.caption || unwrapped?.videoMessage?.caption || '';
        }
      }

      if (!newDesc) {
        await sock.sendMessage(chatJid, { text: '❌ Please specify the new group description or reply to a text message.\n\nUsage: `.setdesc Welcome to the official Hijjaze Community.`' }, { quoted: msg });
        return;
      }

      if (newDesc.length > 2048) {
        await sock.sendMessage(chatJid, { text: '❌ Description is too long. Maximum allowed length is 2048 characters.' }, { quoted: msg });
        return;
      }

      const oldDesc = perm.metadata?.desc || 'None';

      try {
        await sock.groupUpdateDescription(chatJid, newDesc);

        const { timeStr } = getFormattedDateTime();
        const senderNum = perm.cleanSender.split('@')[0];

        const successBox = createBox('🏘️ 𝗚𝗥𝗢𝗨𝗣 𝗦𝗘𝗧𝗧𝗜𝗡𝗚𝗦',
`• 📊 Status: Group Description Updated
• ✨ New Desc: ${newDesc}
• 👤 By: @${senderNum} • ⏰ Time: ${timeStr}`
        );

        await sock.sendMessage(chatJid, {
          text: successBox,
          mentions: [perm.cleanSender]
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[SetDesc] Error updating description:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to update group description. Error: ${err?.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'seticon',
    aliases: ['setpp', 'setgrouppp', 'setpfp', 'groupicon'],
    category: '👥 GROUP',
    description: 'Set replied image as the new group profile picture',
    usage: 'Reply to an image with .seticon',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can change group icon.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to update profile picture.' }, { quoted: msg });
        return;
      }

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                          msg.message?.imageMessage?.contextInfo;

      let targetMediaMsg: any = null;
      if (contextInfo?.quotedMessage) {
        const unwrapped = unwrapMessage(contextInfo.quotedMessage);
        if (unwrapped?.imageMessage) {
          targetMediaMsg = { message: unwrapped };
        } else if (unwrapped?.videoMessage || unwrapped?.stickerMessage || unwrapped?.documentMessage || unwrapped?.audioMessage) {
          await sock.sendMessage(chatJid, { text: '❌ Unsupported media format. Please reply to an image (JPG/PNG).' }, { quoted: msg });
          return;
        }
      } else if (msg.message?.imageMessage) {
        targetMediaMsg = msg;
      }

      if (!targetMediaMsg) {
        await sock.sendMessage(chatJid, { text: '❌ Please reply to an image message with `.seticon` to set group icon.' }, { quoted: msg });
        return;
      }

      try {
        await sock.sendPresenceUpdate('composing', chatJid);
        const imageBuffer = await downloadMediaMessage(targetMediaMsg, 'buffer', {});
        if (!imageBuffer || imageBuffer.length < 100) {
          await sock.sendMessage(chatJid, { text: '❌ Failed to download image. Please try again.' }, { quoted: msg });
          return;
        }

        await sock.updateProfilePicture(chatJid, imageBuffer);

        const { timeStr } = getFormattedDateTime();
        const senderNum = perm.cleanSender.split('@')[0];

        const successBox = createBox('🏘️ 𝗚𝗥𝗢𝗨𝗣 𝗦𝗘𝗧𝗧𝗜𝗡𝗚𝗦',
`• 📊 Status: Group Icon Updated
• 👤 By: @${senderNum} • ⏰ Time: ${timeStr}`
        );

        await sock.sendMessage(chatJid, {
          text: successBox,
          mentions: [perm.cleanSender]
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[SetIcon] Error updating profile picture:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to update group icon. Error: ${err?.message || 'WhatsApp action failed'}` }, { quoted: msg });
      } finally {
        try { await sock.sendPresenceUpdate('paused', chatJid); } catch (e) {}
      }
    }
  },
  {
    name: 'removeicon',
    aliases: ['removepp', 'delpp', 'deletepp', 'delicon', 'delpfp', 'removepfp'],
    category: '👥 GROUP',
    description: 'Remove the current group profile picture',
    usage: '.removeicon',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can remove group icon.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to remove profile picture.' }, { quoted: msg });
        return;
      }

      try {
        await sock.removeProfilePicture(chatJid);

        const { timeStr } = getFormattedDateTime();
        const senderNum = perm.cleanSender.split('@')[0];

        const successBox = createBox('🏘️ 𝗚𝗥𝗢𝗨𝗣 𝗦𝗘𝗧𝗧𝗜𝗡𝗚𝗦',
`• 📊 Status: Group Icon Removed
• 👤 By: @${senderNum} • ⏰ Time: ${timeStr}`
        );

        await sock.sendMessage(chatJid, {
          text: successBox,
          mentions: [perm.cleanSender]
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[RemoveIcon] Error removing profile picture:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to remove group icon. Error: ${err?.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'groupinfo',
    aliases: ['ginfo', 'infogroup', 'gcinfo'],
    category: '👥 GROUP',
    description: 'Display detailed information and settings of the current group',
    usage: '.groupinfo',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, userId } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }

      const meta = perm.metadata || {};
      const subject = meta.subject || 'WhatsApp Group';
      const description = meta.desc || 'No description set.';

      const totalMembers = perm.participants.length;
      let adminCount = 0;
      let regularCount = 0;
      let ownerJid = meta.owner || '';

      for (const p of perm.participants) {
        if (p.admin === 'superadmin') {
          adminCount++;
          if (!ownerJid) ownerJid = cleanJid(p.id);
        } else if (p.admin === 'admin') {
          adminCount++;
        } else {
          regularCount++;
        }
      }

      const ownerMention = ownerJid ? `@${ownerJid.split('@')[0]}` : 'Group Creator';

      let creationStr = 'Unknown';
      if (meta.creation) {
        try {
          const cDate = new Date(meta.creation * 1000);
          creationStr = cDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch (e) {}
      }

      const announceMode = meta.announce ? '🔒 Admins Only' : '💬 All Members';
      const restrictMode = meta.restrict ? '🔒 Admins Only' : '✏️ All Members';
      const botAdminStatus = perm.isBotAdmin ? '✅ Admin' : '❌ Member';
      const currentMode = getBotMode(userId).toUpperCase();

      let inviteLinkStatus = '🔒 Admin Only to view';
      if (perm.isBotAdmin && perm.isUserAdmin) {
        try {
          const code = await sock.groupInviteCode(chatJid);
          inviteLinkStatus = `https://chat.whatsapp.com/${code}`;
        } catch (e) {
          inviteLinkStatus = '⚠️ Unable to fetch invite link';
        }
      }

      const infoText = createBox('🏘️ 𝗚𝗥𝗢𝗨𝗣 𝗜𝗡𝗙𝗢',
`• 📛 Group: ${subject}
• 👑 Owner: ${ownerMention}
• 📊 Members: ${totalMembers} (${adminCount} Admins)
• ⚙️ Settings: ${announceMode} • ${restrictMode}
• 🔗 Link: ${inviteLinkStatus}
• 📝 Desc: ${description}`
      );

      const mentions = ownerJid ? [ownerJid] : [];

      try {
        const ppUrl = await sock.profilePictureUrl(chatJid, 'image');
        if (ppUrl) {
          await sock.sendMessage(chatJid, {
            image: { url: ppUrl },
            caption: infoText,
            mentions
          }, { quoted: msg });
          return;
        }
      } catch (e) {
        // No profile picture found or fetching failed
      }

      await sock.sendMessage(chatJid, { text: infoText, mentions }, { quoted: msg });
    }
  },
  {
    name: 'link',
    aliases: ['grouplink', 'gclink', 'invitelink', 'getlink'],
    category: '👥 GROUP',
    description: 'Display the current WhatsApp group invite link',
    usage: '.link',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can fetch the invite link.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to get the invite link.' }, { quoted: msg });
        return;
      }

      try {
        const code = await sock.groupInviteCode(chatJid);
        const groupName = perm.metadata?.subject || 'Group';

        const linkBox = createBox('🔗 𝗚𝗥𝗢𝗨𝗣 𝗟𝗜𝗡𝗞',
`• 📌 Group: ${groupName}
• 🔗 Link: https://chat.whatsapp.com/${code}`
        );

        await sock.sendMessage(chatJid, { text: linkBox }, { quoted: msg });
      } catch (err: any) {
        console.error('[Link] Error fetching invite code:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to fetch group invite link. Error: ${err?.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'revoke',
    aliases: ['revokelink', 'resetlink', 'newlink', 'resetinvite'],
    category: '👥 GROUP',
    description: 'Reset the group invite link and generate a brand new one',
    usage: '.revoke',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can revoke the invite link.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to revoke invite links.' }, { quoted: msg });
        return;
      }

      try {
        const newCode = await sock.groupRevokeInvite(chatJid);
        const senderNum = perm.cleanSender.split('@')[0];

        const revokeBox = createBox('🔄 𝗜𝗡𝗩𝗜𝗧𝗘 𝗟𝗜𝗡𝗞 𝗥𝗘𝗩𝗢𝗞𝗘𝗗',
`• 📊 Status: Link Reset
• 🔗 New Link: https://chat.whatsapp.com/${newCode}
• 👤 By: @${senderNum}`
        );

        await sock.sendMessage(chatJid, {
          text: revokeBox,
          mentions: [perm.cleanSender]
        }, { quoted: msg });
      } catch (err: any) {
        console.error('[Revoke] Error revoking invite link:', err);
        await sock.sendMessage(chatJid, { text: `❌ Failed to revoke invite link. Error: ${err?.message || 'WhatsApp action failed'}` }, { quoted: msg });
      }
    }
  },
  {
    name: 'warn',
    aliases: ['warning', 'addwarn'],
    category: '👥 GROUP',
    description: 'Issue a warning to mentioned member(s)',
    usage: '.warn @user [reason]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can issue warnings.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to issue warnings.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention member(s) or reply to a message to warn.\n\nUsage: `.warn @user Spamming`' }, { quoted: msg });
        return;
      }

      const cleanArgs = args.filter(a => !a.startsWith('@') && !targets.some(t => t.startsWith(a.replace(/[^0-9]/g, ''))));
      const reason = cleanArgs.join(' ').trim() || 'No reason specified';
      const { timeStr } = getFormattedDateTime();
      const senderNum = perm.cleanSender.split('@')[0];

      for (const target of targets) {
        if (target === perm.botJid) {
          await sock.sendMessage(chatJid, { text: '❌ Bot cannot warn itself.' }, { quoted: msg });
          continue;
        }

        const participant = findParticipant(perm.participants, target);
        const targetJid = cleanJid(participant?.id || participant?.jid || target);

        if (participant && participant.admin === 'superadmin') {
          await sock.sendMessage(chatJid, { text: `❌ Cannot warn the Group Owner (@${targetJid.split('@')[0]}).`, mentions: [targetJid] }, { quoted: msg });
          continue;
        }

        const updatedWarns = addWarning(chatJid, targetJid, reason, perm.cleanSender);
        const count = updatedWarns.length;
        const targetNum = targetJid.split('@')[0];

        if (count >= 3) {
          try {
            await sock.groupParticipantsUpdate(chatJid, [targetJid], 'remove');
            clearWarnings(chatJid, targetJid);

            const autoKickBox = createBox('🚨 𝗔𝗨𝗧𝗢 𝗥𝗘𝗠𝗢𝗩𝗔𝗟',
`• 👤 User: @${targetNum}
• 📊 Status: Limit Reached (${count}/3 Warnings)
• 📝 Reason: ${reason}
• 👮 By: @${senderNum} • ⏰ Time: ${timeStr}`
            );

            await sock.sendMessage(chatJid, {
              text: autoKickBox,
              mentions: [target, perm.cleanSender]
            }, { quoted: msg });
          } catch (kickErr: any) {
            console.error('[Warn Auto-Kick Error]', kickErr);
            await sock.sendMessage(chatJid, {
              text: `⚠️ User @${targetNum} reached ${count}/3 warnings, but bot failed to remove them: ${kickErr.message || 'Permission error'}`,
              mentions: [target]
            }, { quoted: msg });
          }
        } else {
          const remaining = 3 - count;
          const warnBox = createBox('🛡️ 𝗪𝗔𝗥𝗡𝗜𝗡𝗚 𝗜𝗦𝗦𝗨𝗘𝗗',
`• 👤 User: @${targetNum}
• 📊 Warning: ${count} / 3 (${remaining} left)
• 📝 Reason: ${reason}
• 👮 By: @${senderNum} • ⏰ Time: ${timeStr}`
          );

          await sock.sendMessage(chatJid, {
            text: warnBox,
            mentions: [target, perm.cleanSender]
          }, { quoted: msg });
        }
      }
    }
  },
  {
    name: 'warnings',
    aliases: ['warns', 'warnlist', 'mywarns'],
    category: '👥 GROUP',
    description: 'Display warning history for a user',
    usage: '.warnings [@user]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }

      let targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        targets = [perm.cleanSender];
      }

      for (const target of targets) {
        const targetNum = target.split('@')[0];
        const warns = getWarnings(chatJid, target);
        const count = warns.length;
        const remaining = Math.max(0, 3 - count);

        let warnHistoryStr = '• _No warning records found. Good standing! ✅_';

        if (warns.length > 0) {
          warnHistoryStr = warns.map((w, idx) => {
            const dateStr = new Date(w.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const adminNum = w.issuedBy.split('@')[0];
            return `*${idx + 1}.* ${w.reason}\n   └ 👮 @${adminNum} • 🕒 ${dateStr}`;
          }).join('\n\n');
        }

        const allMentions = [target, ...warns.map(w => w.issuedBy)];

        const warningsBox = createBox('⚠️ 𝗪𝗔𝗥𝗡𝗜𝗡𝗚 𝗛𝗜𝗦𝗧𝗢𝗥𝗬',
`• 👤 User: @${targetNum}
• 📊 Total Warnings: ${count} / 3 (${remaining} left)
• 📋 History: ${warns.length > 0 ? warns.map(w => w.reason).join(' | ') : 'No warnings ✅'}`
        );

        await sock.sendMessage(chatJid, {
          text: warningsBox,
          mentions: Array.from(new Set(allMentions))
        }, { quoted: msg });
      }
    }
  },
  {
    name: 'clearwarn',
    aliases: ['clearwarnings', 'resetwarn', 'delwarn'],
    category: '👥 GROUP',
    description: 'Clear all warning records for a user',
    usage: '.clearwarn @user',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can clear warnings.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention member(s) or reply to a message to clear warnings.\n\nUsage: `.clearwarn @user`' }, { quoted: msg });
        return;
      }

      const senderNum = perm.cleanSender.split('@')[0];
      const clearedMentions: string[] = [];

      for (const target of targets) {
        clearWarnings(chatJid, target);
        clearedMentions.push(target);
      }

      const mentionsList = clearedMentions.map(t => `@${t.split('@')[0]}`).join(', ');

      const clearBox = createBox('🧹 𝗪𝗔𝗥𝗡𝗜𝗡𝗚𝗦 𝗖𝗟𝗘𝗔𝗥𝗘𝗗',
`• 👤 Reset For: ${mentionsList}
• 📊 Status: Warnings Cleared
• 👮 By: @${senderNum}`
      );

      await sock.sendMessage(chatJid, {
        text: clearBox,
        mentions: [...clearedMentions, perm.cleanSender]
      }, { quoted: msg });
    }
  },
  {
    name: 'muteuser',
    aliases: ['mutebot', 'mutecmd', 'botmute'],
    category: '👥 GROUP',
    description: 'Mute a user from using Hijjaze Bot commands in this group',
    usage: '.muteuser @user [duration] [reason]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can mute users.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention member(s) or reply to a message to mute.\n\nUsage: `.muteuser @user 24h Spamming commands`' }, { quoted: msg });
        return;
      }

      const { durationMs, displayStr, reason } = parseDurationMs(args, targets);
      const { timeStr } = getFormattedDateTime();
      const senderNum = perm.cleanSender.split('@')[0];

      for (const target of targets) {
        if (target === perm.botJid) {
          await sock.sendMessage(chatJid, { text: '❌ Bot cannot mute itself.' }, { quoted: msg });
          continue;
        }

        const participant = perm.participants.find((p: any) => cleanJid(p.id) === target);
        if (participant && participant.admin === 'superadmin') {
          await sock.sendMessage(chatJid, { text: `❌ Cannot mute group owner (@${target.split('@')[0]}).`, mentions: [target] }, { quoted: msg });
          continue;
        }

        muteUser(chatJid, target, perm.cleanSender, reason, durationMs);
        const targetNum = target.split('@')[0];

        const muteBox = createBox('🔇 𝗖𝗢𝗠𝗠𝗔𝗡𝗗 𝗠𝗨𝗧𝗘',
`• 👤 User: @${targetNum}
• ⏱️ Duration: ${displayStr}
• 📝 Reason: ${reason}
• 👮 By: @${senderNum} • ⏰ Time: ${timeStr}`
        );

        await sock.sendMessage(chatJid, {
          text: muteBox,
          mentions: [target, perm.cleanSender]
        }, { quoted: msg });
      }
    }
  },
  {
    name: 'unmuteuser',
    aliases: ['unmutebot', 'unmutecmd', 'botunmute'],
    category: '👥 GROUP',
    description: 'Restore a user\'s ability to use bot commands in this group',
    usage: '.unmuteuser @user',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can unmute users.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention member(s) or reply to a message to unmute.\n\nUsage: `.unmuteuser @user`' }, { quoted: msg });
        return;
      }

      const senderNum = perm.cleanSender.split('@')[0];
      const unmutedList: string[] = [];

      for (const target of targets) {
        unmuteUser(chatJid, target);
        unmutedList.push(target);
      }

      const mentionsList = unmutedList.map(t => `@${t.split('@')[0]}`).join(', ');

      const unmuteBox = createBox('🔊 𝗖𝗢𝗠𝗠𝗔𝗡𝗗 𝗨𝗡𝗠𝗨𝗧𝗘',
`• 👤 User: ${mentionsList}
• 📊 Status: Unmuted
• 👮 By: @${senderNum}`
      );

      await sock.sendMessage(chatJid, {
        text: unmuteBox,
        mentions: [...unmutedList, perm.cleanSender]
      }, { quoted: msg });
    }
  },
  {
    name: 'ban',
    aliases: ['banuser', 'groupban', 'gban'],
    category: '👥 GROUP',
    description: 'Permanently ban a user from the group and prevent re-joining',
    usage: '.ban @user [reason]',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can ban members.' }, { quoted: msg });
        return;
      }
      if (!perm.isBotAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Bot needs to be a Group Admin to ban members.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please mention member(s) or reply to a message to ban.\n\nUsage: `.ban @user Repeated rule violations`' }, { quoted: msg });
        return;
      }

      const cleanArgs = args.filter(a => !a.startsWith('@') && !targets.some(t => t.startsWith(a.replace(/[^0-9]/g, ''))));
      const reason = cleanArgs.join(' ').trim() || 'Repeated rule violations';
      const { timeStr } = getFormattedDateTime();
      const senderNum = perm.cleanSender.split('@')[0];

      for (const target of targets) {
        if (target === perm.botJid) {
          await sock.sendMessage(chatJid, { text: '❌ Bot cannot ban itself.' }, { quoted: msg });
          continue;
        }

        const participant = findParticipant(perm.participants, target);
        const targetJid = cleanJid(participant?.id || participant?.jid || target);

        if (participant && participant.admin === 'superadmin') {
          await sock.sendMessage(chatJid, { text: `❌ Cannot ban group owner (@${targetJid.split('@')[0]}).`, mentions: [targetJid] }, { quoted: msg });
          continue;
        }

        banUser(chatJid, targetJid, perm.cleanSender, reason);
        const targetNum = targetJid.split('@')[0];

        try {
          await sock.groupParticipantsUpdate(chatJid, [targetJid], 'remove');
        } catch (removeErr) {
          console.error('[Ban Remove Error]', removeErr);
        }

        const banBox = createBox('🚫 𝗚𝗥𝗢𝗨𝗣 𝗕𝗔𝗡',
`• 👤 Banned: @${targetNum}
• 📝 Reason: ${reason}
• 👮 By: @${senderNum} • ⏰ Time: ${timeStr}`
        );

        await sock.sendMessage(chatJid, {
          text: banBox,
          mentions: [target, perm.cleanSender]
        }, { quoted: msg });
      }
    }
  },
  {
    name: 'unban',
    aliases: ['unbanuser', 'groupunban'],
    category: '👥 GROUP',
    description: 'Lift group ban for a user',
    usage: '.unban @user or phone number',
    handler: async (ctx) => {
      const { sock, msg, chatJid, senderJid, args } = ctx;
      const isFromMe = !!msg.key.fromMe;

      const perm = await getGroupPermissions(sock, chatJid, senderJid, isFromMe);
      if (!perm.isGroup) {
        await sock.sendMessage(chatJid, { text: '❌ This command can only be used inside WhatsApp Groups.' }, { quoted: msg });
        return;
      }
      if (!perm.isUserAdmin) {
        await sock.sendMessage(chatJid, { text: '❌ Only group admins or the bot owner can unban members.' }, { quoted: msg });
        return;
      }

      const targets = extractTargetJids(msg, args);
      if (targets.length === 0) {
        await sock.sendMessage(chatJid, { text: '❌ Please specify target user by mention or phone number.\n\nUsage: `.unban @user` or `.unban 923001234567`' }, { quoted: msg });
        return;
      }

      const senderNum = perm.cleanSender.split('@')[0];
      const unbannedList: string[] = [];

      for (const target of targets) {
        unbanUser(chatJid, target);
        unbannedList.push(target);
      }

      const mentionsList = unbannedList.map(t => `@${t.split('@')[0]}`).join(', ');

      const unbanBox = createBox('🔓 𝗚𝗥𝗢𝗨𝗣 𝗨𝗡𝗕𝗔𝗡',
`• 👤 Unbanned: ${mentionsList}
• 📊 Status: Ban Lifted
• 👮 By: @${senderNum}`
      );

      await sock.sendMessage(chatJid, {
        text: unbanBox,
        mentions: [...unbannedList, perm.cleanSender]
      }, { quoted: msg });
    }
  },
  {
    name: 'video',
    aliases: ['mp4', 'ytvideo', 'ytmp4', 'v'],
    category: '📥 DOWNLOAD',
    description: 'Searches YouTube and downloads the requested video directly to WhatsApp',
    usage: '.video <search query>',
    handler: async (ctx) => {
      const { sock, msg, chatJid, args } = ctx;
      const searchQuery = args.join(' ').trim();

      if (!searchQuery) {
        const errorMsg = `❌ *Missing Search Query!*

Please specify what video you want to search and download.

📌 *Usage:* \`.video <search query>\`
💡 *Example:* \`.video Makkah Clock Tower\`
💡 *Example:* \`.video Beautiful Quran Recitation\``;
        await sock.sendMessage(chatJid, { text: errorMsg }, { quoted: msg });
        return;
      }

      // Step 1: Send Searching status message
      const searchingText = `🔎 *Searching YouTube for:* "${searchQuery}"\n⏳ *Please wait while Hijjaze Bot processes your video...*`;
      let tempMsg: any = null;
      let cardMsg: any = null;
      try {
        tempMsg = await sock.sendMessage(chatJid, { text: searchingText }, { quoted: msg });
      } catch (e) {
        console.warn('Could not send initial search status message:', e);
      }

      try {
        // Step 2: Search YouTube & pick best match
        const video = await searchYouTubeVideo(searchQuery);

        if (!video) {
          const noResultText = `❌ *No Video Found*\n\nSorry, no matching video was found for "${searchQuery}". Please try a different search query.`;
          if (tempMsg?.key) {
            await sock.sendMessage(chatJid, { text: noResultText, edit: tempMsg.key });
          } else {
            await sock.sendMessage(chatJid, { text: noResultText }, { quoted: msg });
          }
          return;
        }

        // Step 3: Send Thumbnail Image Card with Video Metadata Data first
        const infoCaption = `🎬 *Title:* ${video.title}
👤 *Channel:* ${video.author}
⏱ *Duration:* ${video.duration}
📅 *Uploaded:* ${video.ago}
👀 *Views:* ${video.views}

📥 *Status:* Downloading video to WhatsApp... Please wait! ⏳`;

        cardMsg = null;
        if (video.image || video.thumbnail) {
          try {
            cardMsg = await sock.sendMessage(
              chatJid,
              {
                image: { url: video.image || video.thumbnail },
                caption: infoCaption
              },
              { quoted: msg }
            );
          } catch (imgErr) {
            console.warn('Could not send thumbnail image card:', imgErr);
          }
        }

        if (!cardMsg) {
          try {
            cardMsg = await sock.sendMessage(chatJid, { text: infoCaption }, { quoted: msg });
          } catch (e) {}
        }

        // Clean up initial searching text if separate
        if (tempMsg?.key) {
          try {
            await sock.sendMessage(chatJid, { delete: tempMsg.key });
          } catch (e) {}
        }

        // Step 4: Download Video Buffer
        const downloadResult = await downloadVideoBuffer(video.url, video.videoId);

        // Fetch JPEG thumbnail buffer for WhatsApp native video player preview
        let jpegThumbBuf: Buffer | undefined = undefined;
        if (video.image || video.thumbnail) {
          try {
            const thumbRes = await fetch(video.image || video.thumbnail, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            if (thumbRes.ok) {
              const ab = await thumbRes.arrayBuffer();
              jpegThumbBuf = Buffer.from(ab);
            }
          } catch (e) {
            console.warn('Could not fetch thumbnail buffer for video payload:', e);
          }
        }

        const cleanFileName = (video.title || 'video')
          .replace(/[^\w\s-]/gi, '')
          .trim()
          .substring(0, 60) || 'video';

        const videoCaption = `🎬 *${video.title}*
👤 *Channel:* ${video.author} | ⏱ *Duration:* ${video.duration}

🤖 *Downloaded by Hijjaze Bot*`;

        // Step 5: Send Video to WhatsApp with fileName and jpegThumbnail so memory playback succeeds
        await sock.sendMessage(
          chatJid,
          {
            video: downloadResult.buffer,
            caption: videoCaption,
            mimetype: downloadResult.mimetype || 'video/mp4',
            fileName: `${cleanFileName}.mp4`,
            ...(jpegThumbBuf ? { jpegThumbnail: jpegThumbBuf } : {})
          },
          { quoted: msg }
        );

        // Update card status to complete
        if (cardMsg?.key) {
          try {
            await sock.sendMessage(chatJid, {
              text: `🎬 *Title:* ${video.title}\n👤 *Channel:* ${video.author}\n⏱ *Duration:* ${video.duration}\n📅 *Uploaded:* ${video.ago}\n👀 *Views:* ${video.views}\n\n✅ *Status:* Video Download Completed & Sent!`,
              edit: cardMsg.key
            });
          } catch (e) {}
        }
      } catch (err: any) {
        console.error('Error executing .video command:', err);
        const failText = `❌ *Download Failed*\n\nAn error occurred while downloading the video for "${searchQuery}".\n\n*Reason:* ${err?.message || 'Server error or video restriction'}\n\nPlease try again or search with a different query.`;
        if (cardMsg?.key) {
          try {
            await sock.sendMessage(chatJid, { text: failText, edit: cardMsg.key });
          } catch (e) {
            await sock.sendMessage(chatJid, { text: failText }, { quoted: msg });
          }
        } else if (tempMsg?.key) {
          try {
            await sock.sendMessage(chatJid, { text: failText, edit: tempMsg.key });
          } catch (e) {
            await sock.sendMessage(chatJid, { text: failText }, { quoted: msg });
          }
        } else {
          await sock.sendMessage(chatJid, { text: failText }, { quoted: msg });
        }
      }
    }
  },
  {
    name: 'play',
    aliases: ['song', 'playmp3', 'ytplay', 'music', 'audio', 'sing', 'p'],
    category: '📥 DOWNLOAD',
    description: 'Searches for music/audio on YouTube and sends high quality MP3 audio directly to WhatsApp',
    usage: '.play <song name>',
    handler: async (ctx) => {
      const { sock, msg, chatJid, args } = ctx;
      const searchQuery = args.join(' ').trim();

      if (!searchQuery) {
        const errorMsg = `❌ *Missing Search Query!*

Please specify the song, nasheed, or audio name you want to search and play.

📌 *Usage:* \`.play <song name>\`
💡 *Example:* \`.play Nasheed\`
💡 *Example:* \`.play Surah Ar-Rahman Mishary\`
💡 *Example:* \`.play Believer Imagine Dragons\`
💡 *Example:* \`.play Shape of You\`
💡 *Example:* \`.play Pashto Tappy\``;
        await sock.sendMessage(chatJid, { text: errorMsg }, { quoted: msg });
        return;
      }

      // Step 1: Display temporary search status message
      const searchingText = `🔎 Searching for audio...\nPlease wait...`;
      let tempMsg: any = null;
      let cardMsg: any = null;
      try {
        tempMsg = await sock.sendMessage(chatJid, { text: searchingText }, { quoted: msg });
      } catch (e) {
        console.warn('Could not send initial play search status message:', e);
      }

      const cacheKey = searchQuery.toLowerCase().trim();
      const cached = playAudioCache.get(cacheKey);
      const isCacheValid = cached && (Date.now() - cached.timestamp < 3600000); // 1 hour

      try {
        let audio: any;
        let downloadResult: any;

        if (isCacheValid) {
          audio = cached.audio;
          downloadResult = cached.downloadResult;
        } else {
          // Step 2: Search YouTube for requested song with smart ranking
          audio = await searchYouTubeAudio(searchQuery);

          if (!audio) {
            const noResultText = `❌ No matching audio found.\nTry another song name.`;
            if (tempMsg?.key) {
              await sock.sendMessage(chatJid, { text: noResultText, edit: tempMsg.key });
            } else {
              await sock.sendMessage(chatJid, { text: noResultText }, { quoted: msg });
            }
            return;
          }

          // Step 3: Send Thumbnail Image Card with Audio Metadata
          const infoCaption = `🎵 *Title:* ${audio.title}
👤 *Artist/Channel:* ${audio.author}
⏱ *Duration:* ${audio.duration}
📅 *Uploaded:* ${audio.ago}
👀 *Views:* ${audio.views}
📦 *Audio Size:* Fetching size...

📥 *Status:* Downloading audio... Please wait! ⏳`;

          if (audio.image || audio.thumbnail) {
            try {
              cardMsg = await sock.sendMessage(
                chatJid,
                {
                  image: { url: audio.image || audio.thumbnail },
                  caption: infoCaption
                },
                { quoted: msg }
              );
            } catch (imgErr) {
              console.warn('Could not send audio thumbnail image card:', imgErr);
            }
          }

          if (!cardMsg) {
            try {
              cardMsg = await sock.sendMessage(chatJid, { text: infoCaption }, { quoted: msg });
            } catch (e) {}
          }

          // Clean up initial searching text if separate
          if (tempMsg?.key) {
            try {
              await sock.sendMessage(chatJid, { delete: tempMsg.key });
            } catch (e) {}
          }

          // Step 4: Download Audio Buffer (high quality MP3)
          downloadResult = await downloadAudioBuffer(audio.url, audio.videoId);

          // Save to cache
          playAudioCache.set(cacheKey, {
            audio,
            downloadResult,
            timestamp: Date.now()
          });
        }

        const cleanFileName = (audio.title || 'audio')
          .replace(/[^\w\s-]/gi, '')
          .trim()
          .substring(0, 60) || 'audio';

        // Step 5: Send Audio directly to WhatsApp
        await sock.sendMessage(
          chatJid,
          {
            audio: downloadResult.buffer,
            mimetype: 'audio/mp4',
            fileName: `${cleanFileName}.mp3`,
            ptt: false
          },
          { quoted: msg }
        );

        // Step 6: Update Thumbnail Card with complete info
        const completeCaption = `🎵 *Title:* ${audio.title}
👤 *Artist/Channel:* ${audio.author}
⏱ *Duration:* ${audio.duration}
📅 *Uploaded:* ${audio.ago}
👀 *Views:* ${audio.views}
📦 *Audio Size:* ${downloadResult.sizeFormatted}

🤖 *Downloaded by Hijjaze Bot*`;

        if (cardMsg?.key) {
          try {
            await sock.sendMessage(chatJid, {
              text: completeCaption,
              edit: cardMsg.key
            });
          } catch (e) {}
        } else if (tempMsg?.key) {
          try {
            await sock.sendMessage(chatJid, {
              text: completeCaption,
              edit: tempMsg.key
            });
          } catch (e) {}
        }
      } catch (err: any) {
        console.error('Error executing .play command:', err);
        const failText = `⚠️ Failed to download the audio.\nPlease try again later.`;
        if (cardMsg?.key) {
          try {
            await sock.sendMessage(chatJid, { text: failText, edit: cardMsg.key });
          } catch (e) {
            await sock.sendMessage(chatJid, { text: failText }, { quoted: msg });
          }
        } else if (tempMsg?.key) {
          try {
            await sock.sendMessage(chatJid, { text: failText, edit: tempMsg.key });
          } catch (e) {
            await sock.sendMessage(chatJid, { text: failText }, { quoted: msg });
          }
        } else {
          await sock.sendMessage(chatJid, { text: failText }, { quoted: msg });
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

// Helper to convert standard text into bold sans-serif Unicode
export function toBoldSans(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      result += String.fromCodePoint(code - 65 + 120276);
    } else if (code >= 97 && code <= 122) {
      result += String.fromCodePoint(code - 97 + 120302);
    } else if (code >= 48 && code <= 57) {
      result += String.fromCodePoint(code - 48 + 120812);
    } else {
      result += text[i];
    }
  }
  return result;
}

// Format memory/RAM usage
export function getRamUsage(): string {
  try {
    const mem = process.memoryUsage();
    return `${(mem.rss / 1024 / 1024).toFixed(1)} MB`;
  } catch (err) {
    return 'Unknown MB';
  }
}

// Get beautifully formatted date and time in IST (Asia/Kolkata)
export function getFormattedDateTime() {
  try {
    const dateObj = new Date();
    const dateStr = dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
    const timeStr = dateObj.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });
    return { dateStr, timeStr };
  } catch (e) {
    try {
      const dateObj = new Date();
      const dateStr = dateObj.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const timeStr = dateObj.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
      return { dateStr, timeStr };
    } catch (err) {
      const d = new Date();
      return { dateStr: d.toDateString(), timeStr: d.toTimeString().split(' ')[0] };
    }
  }
}

// Map registered command categories to beautiful category display names
export function getDisplayCategoryTitle(cmd: Command): string {
  if (cmd.ownerOnly) {
    return `👑 ${toBoldSans('OWNER COMMANDS')}`;
  }
  const rawCat = (cmd.category || 'GENERAL').toUpperCase();
  const cleanCat = rawCat.replace(/[^A-Z\s]/g, '').trim();

  if (cleanCat.includes('AI')) return `🤖 ${toBoldSans('AI COMMANDS')}`;
  if (cleanCat.includes('GENERAL')) return `🌐 ${toBoldSans('GENERAL COMMANDS')}`;
  if (cleanCat.includes('ADMIN')) return `👮 ${toBoldSans('ADMIN COMMANDS')}`;
  if (cleanCat.includes('GROUP')) return `👥 ${toBoldSans('GROUP COMMANDS')}`;
  if (cleanCat.includes('DOWNLOAD')) return `🎵 ${toBoldSans('DOWNLOAD COMMANDS')}`;
  if (cleanCat.includes('STICKER')) return `🎨 ${toBoldSans('STICKER COMMANDS')}`;
  if (cleanCat.includes('IMAGE') || cleanCat.includes('MEDIA')) return `🎨 ${toBoldSans('IMAGE COMMANDS')}`;
  if (cleanCat.includes('UTILITY')) return `🛠️ ${toBoldSans('UTILITY COMMANDS')}`;
  if (cleanCat.includes('TOOL')) return `🔧 ${toBoldSans('TOOLS')}`;
  if (cleanCat.includes('FUN')) return `🎮 ${toBoldSans('FUN COMMANDS')}`;
  if (cleanCat.includes('ISLAMIC')) return `🕌 ${toBoldSans('ISLAMIC COMMANDS')}`;
  if (cleanCat.includes('INFO') || cleanCat.includes('INFORMATION') || cleanCat.includes('SEARCH')) return `📚 ${toBoldSans('INFORMATION COMMANDS')}`;
  if (cleanCat.includes('SYSTEM')) return `⚙️ ${toBoldSans('SYSTEM COMMANDS')}`;
  if (cleanCat.includes('PREMIUM')) return `⭐ ${toBoldSans('PREMIUM COMMANDS')}`;

  return `✨ ${toBoldSans(cleanCat + ' COMMANDS')}`;
}

export function getDisplayCategory(cmd: Command): string {
  return getDisplayCategoryTitle(cmd);
}

// Detect theme type based on text content and active command
export function detectThemeType(text: string, cmd?: Command): string {
  const cleanText = text.trim();
  
  if (cleanText.startsWith('❌') || cleanText.includes('Error:') || cleanText.toLowerCase().includes('failed')) {
    return 'error';
  }
  if (cleanText.startsWith('✅') || cleanText.toLowerCase().includes('success')) {
    return 'success';
  }
  if (cleanText.startsWith('⚠️') || cleanText.toLowerCase().includes('warning')) {
    return 'warning';
  }
  if (cleanText.startsWith('ℹ️') || cleanText.startsWith('🔔')) {
    return 'info';
  }
  
  if (cmd) {
    if (cmd.ownerOnly) return 'owner';
    const cat = cmd.category.toUpperCase().replace(/[^A-Z\s]/g, '').trim();
    if (cat.includes('AI')) return 'ai';
    if (cat.includes('FUN')) return 'fun';
    if (cat.includes('SYSTEM')) return 'system';
    if (cat.includes('UTILITY')) return 'utility';
    if (cat.includes('INFORMATION') || cat.includes('SEARCH')) return 'info';
    if (cat.includes('ADMIN')) return 'admin';
    if (cat.includes('GROUP')) return 'group';
    if (cat.includes('DOWNLOAD')) return 'download';
    if (cat.includes('IMAGE')) return 'image';
    if (cat.includes('MEDIA')) return 'media';
  }
  
  return 'info';
}

export function createBox(headerTitle: string, bodyText: string): string {
  const cleanBody = bodyText.trim();
  return `╭──〔 ${headerTitle} 〕──╮\n\n${cleanBody}\n\n╰────────────────────╯`;
}

// Wrap plain text in a beautifully designed Unicode box according to theme
export function wrapInPremiumBox(text: string, theme: string): string {
  let title = '🤖 𝗛𝗜𝗝𝗝𝗔𝗭𝗘 𝗕𝗢𝗧';
  switch (theme) {
    case 'success': title = '✅ 𝗦𝗨𝗖𝗖𝗘𝗦𝗦'; break;
    case 'error': title = '❌ 𝗘𝗥𝗥𝗢𝗥'; break;
    case 'warning': title = '⚠️ 𝗪𝗔𝗥𝗡𝗜𝗡𝗚'; break;
    case 'ai': title = '🤖 𝗛𝗜𝗝𝗝𝗔𝗭𝗘 𝗔𝗜'; break;
    case 'fun': title = '🎉 𝗛𝗜𝗝𝗝𝗔𝗭𝗘 𝗙𝗨𝗡'; break;
    case 'system': title = '⚙️ 𝗦𝗬𝗦𝗧𝗘𝗠'; break;
    case 'utility': title = '🛠️ 𝗨𝗧𝗜𝗟𝗜𝗧𝗬'; break;
    case 'owner': title = '👑 𝗢𝗪𝗡𝗘𝗥'; break;
    case 'admin': title = '👮 𝗔𝗗𝗠𝗜𝗡'; break;
    case 'group': title = '👥 𝗚𝗥𝗢𝗨𝗣'; break;
    case 'download': title = '⬇️ 𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗥'; break;
    case 'image': title = '🎨 𝗜𝗠𝗔𝗚𝗘'; break;
    case 'media': title = '🎵 𝗠𝗘𝗗𝗜𝗔'; break;
  }

  let cleanText = text.trim();
  if (theme === 'error' && cleanText.startsWith('❌')) {
    cleanText = cleanText.slice(1).trim();
  } else if (theme === 'success' && cleanText.startsWith('✅')) {
    cleanText = cleanText.slice(1).trim();
  } else if (theme === 'warning' && cleanText.startsWith('⚠️')) {
    cleanText = cleanText.slice(1).trim();
  }

  return createBox(title, cleanText);
}

export async function handleIncomingMessage(sock: any, msg: any, userId: string, email: string) {
  if (!msg.message) return;

  const chatJid = msg.key.remoteJid;
  if (!chatJid) return;

  const unwrapped = unwrapMessage(msg.message);
  if (!unwrapped) return;

  let activeCommand: Command | undefined = undefined;

  // Wrapped sock proxy to intercept and beautifully format responses and attach the newsletter/channel button
  const wrappedSock = new Proxy(sock, {
    get(target, prop, receiver) {
      if (prop === 'sendMessage') {
        return async (jid: string, content: any, options: any = {}) => {
          try {
            if (content && typeof content === 'object') {
              const channelConfig = getChannelConfig();

              const forwardedNewsletterMessageInfo = {
                newsletterJid: channelConfig.newsletterJid || '120363426834632590@newsletter',
                serverMessageId: 1,
                newsletterName: channelConfig.name || 'HIJJAZE BOT OFFICIAL CHANNEL'
              };

              const externalAdReply = {
                title: channelConfig.name || 'HIJJAZE BOT OFFICIAL CHANNEL',
                body: '📢 Tap to open WhatsApp Channel',
                mediaType: 1,
                previewType: 'PHOTO',
                sourceUrl: channelConfig.link || 'https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y',
                renderLargerThumbnail: true,
                showAdAttribution: true
              };

              const existingContext = content.contextInfo || {};
              const contextInfo = {
                ...existingContext,
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo,
                externalAdReply
              };

              if (content.text && !content.edit) {
                let responseText = content.text;
                const themeType = detectThemeType(responseText, activeCommand);
                const isFormatted = responseText.includes('╭──〔') || responseText.includes('╰──────') || responseText.includes('╔') || responseText.includes('━━━') || responseText.includes('════');
                if (!isFormatted) {
                  responseText = wrapInPremiumBox(responseText, themeType);
                }

                content = {
                  ...content,
                  text: responseText,
                  contextInfo
                };
              } else {
                content = {
                  ...content,
                  contextInfo
                };
              }
            }
          } catch (err) {
            console.error('[Proxy sendMessage] Error formatting response with channel preview:', err);
          }
          return target.sendMessage(jid, content, options);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    }
  });

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

  // Check if sender is banned in this group -> automatically remove them if bot is admin
  if (chatJid.endsWith('@g.us') && !msg.key.fromMe) {
    const ownerJidTemp = cleanJid(sock.user?.id || '');
    const senderJidTemp = getSenderJid(msg, ownerJidTemp);
    if (isUserBanned(chatJid, senderJidTemp)) {
      console.log(`[Ban Enforcement] Banned user ${senderJidTemp} detected in ${chatJid}. Enforcing ban...`);
      getGroupPermissions(sock, chatJid, senderJidTemp, false).then(async (perm) => {
        if (perm.isBotAdmin) {
          try {
            await sock.groupParticipantsUpdate(chatJid, [senderJidTemp], 'remove');
            await sock.sendMessage(chatJid, {
              text: `🚨 *AUTOMATIC BAN ENFORCEMENT*\n\nUser @${senderJidTemp.split('@')[0]} is banned from this group and has been automatically removed.`,
              mentions: [senderJidTemp]
            });
          } catch (e) {
            console.error('[Ban Enforcement Error]', e);
          }
        }
      });
      return;
    }
  }

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
  activeCommand = command;

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

  // Enforce bot command mute in group
  if (chatJid.endsWith('@g.us') && !isOwner) {
    if (isUserMuted(chatJid, senderJid)) {
      console.log(`[Mute Enforcement] Muted user ${senderJid} attempted to use command .${cmdName} in ${chatJid}. Command ignored.`);
      return;
    }
  }

  // Execute command
  try {
    const ctx: CommandContext = {
      sock: wrappedSock,
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
    await wrappedSock.sendMessage(chatJid, { 
      text: `❌ *Error:* Failed to execute command \`.${cmdName}\`.` 
    }, { quoted: msg });
  }
}
