import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Part } from '@google/genai';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// Session memory structure
interface ChatSession {
  lastActive: number;
  history: {
    role: 'user' | 'model';
    parts: Part[];
  }[];
}

// In-memory store for chat history keyed by senderJid
const chatSessions = new Map<string, ChatSession>();

// Inactivity timeout: 30 minutes
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Initialize the Gemini client
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '') {
    return null;
  }
  try {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  } catch (err) {
    console.error('[GPT-AI] Error initializing Gemini client:', err);
    return null;
  }
}

/**
 * Clean up expired chat sessions to free memory
 */
function pruneExpiredSessions() {
  const now = Date.now();
  for (const [key, session] of chatSessions.entries()) {
    if (now - session.lastActive > SESSION_TIMEOUT_MS) {
      chatSessions.delete(key);
      console.log(`[GPT-AI] Pruned expired chat session for user: ${key}`);
    }
  }
}

// Periodically prune sessions every 5 minutes
setInterval(pruneExpiredSessions, 5 * 60 * 1000);

/**
 * Main function to interact with GPT (Gemini API)
 */
export async function getGptResponse(
  senderJid: string,
  promptText: string,
  mediaFile?: { buffer: Buffer; mimetype: string }
): Promise<string> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('AI service is temporarily unavailable. API Key is not set or invalid.');
  }

  // Get or create session
  pruneExpiredSessions();
  let session = chatSessions.get(senderJid);
  const now = Date.now();

  if (!session || (now - session.lastActive > SESSION_TIMEOUT_MS)) {
    session = {
      lastActive: now,
      history: []
    };
    chatSessions.set(senderJid, session);
  }

  // Update last active timestamp
  session.lastActive = now;

  // Prepare incoming parts
  const userParts: Part[] = [];

  // Add media if present
  if (mediaFile) {
    userParts.push({
      inlineData: {
        data: mediaFile.buffer.toString('base64'),
        mimeType: mediaFile.mimetype
      }
    });
  }

  // Add text prompt
  userParts.push({ text: promptText });

  // Add new turn to history
  session.history.push({
    role: 'user',
    parts: userParts
  });

  // Limit conversation history to the last 12 turns (24 messages total) to preserve context window and performance
  if (session.history.length > 24) {
    session.history = session.history.slice(session.history.length - 24);
  }

  try {
    const systemInstruction = `You are "Hijjaze Bot AI", an extremely advanced, helpful, and friendly AI assistant powered by state-of-the-art technology.
Your goal is to provide accurate, natural, and conversational responses.
Keep your answers beautifully formatted with lists, bold text, and appropriate markdown code blocks where applicable.
Always automatically detect the user's input language and respond in the exact same language (e.g. English, Urdu, Arabic, Spanish, etc.).
You are capable of: question answering, general chatting, coding/debugging in all languages, mathematics, scientific explanation, writing essays/emails, summarizing texts, translation, and Islamic queries.
When analyzing documents, code snippets, or images, provide clear, step-by-step insights and solutions.
Be polite, professional, and friendly. Avoid harmful, offensive, or non-family-friendly content.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: session.history,
      config: {
        systemInstruction,
        // Standard temperature for balanced creativity and accuracy
        temperature: 0.7
      }
    });

    const answer = response.text || 'I was unable to formulate a response.';
    
    // Add model answer to history
    session.history.push({
      role: 'model',
      parts: [{ text: answer }]
    });

    return answer;
  } catch (err) {
    // Remove the failed user turn so we don't pollute the history with unmatched turns
    session.history.pop();
    console.error('[GPT-AI] Error during generateContent:', err);
    throw err;
  }
}

/**
 * Download a media attachment from a quoted message to analyze it
 */
export async function downloadQuotedMedia(quotedMsg: any): Promise<{ buffer: Buffer; mimetype: string } | null> {
  try {
    const msgType = Object.keys(quotedMsg)[0];
    const mediaMsg = quotedMsg[msgType];
    
    if (!mediaMsg || typeof mediaMsg !== 'object') return null;

    // Supported mime types for analyze
    const mimetype = mediaMsg.mimetype || '';
    
    // If it has media properties or a download is possible
    if (
      quotedMsg.imageMessage ||
      quotedMsg.videoMessage ||
      quotedMsg.audioMessage ||
      quotedMsg.documentMessage ||
      quotedMsg.stickerMessage
    ) {
      const buffer = await downloadMediaMessage(
        { key: {}, message: quotedMsg },
        'buffer',
        {},
        {
          rekeyRequest: () => Promise.resolve()
        } as any
      );

      if (buffer && buffer.length > 0) {
        return {
          buffer,
          mimetype: mimetype || getFallbackMimetype(msgType)
        };
      }
    }
  } catch (err) {
    console.error('[GPT-AI] Error downloading quoted media:', err);
  }
  return null;
}

function getFallbackMimetype(msgType: string): string {
  switch (msgType) {
    case 'imageMessage': return 'image/jpeg';
    case 'videoMessage': return 'video/mp4';
    case 'audioMessage': return 'audio/ogg';
    case 'documentMessage': return 'application/pdf';
    case 'stickerMessage': return 'image/webp';
    default: return 'application/octet-stream';
  }
}
