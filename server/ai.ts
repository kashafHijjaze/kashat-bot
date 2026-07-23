import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Part } from '@google/genai';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { hasValidMediaKey } from './commands';

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

    const modelsToTry = ['gemini-3.6-flash', 'gemini-flash-latest'];
    let lastError: any = null;
    let answer: string | undefined;

    for (const modelName of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: session.history,
          config: {
            systemInstruction,
            temperature: 0.7
          }
        });
        if (response.text) {
          answer = response.text;
          break;
        }
      } catch (mErr) {
        lastError = mErr;
        console.warn(`[GPT-AI] Model ${modelName} failed, trying fallback model...`);
      }
    }

    if (!answer) {
      throw lastError || new Error('I was unable to formulate a response.');
    }
    
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
    
    // If it has valid media key, download the buffer
    if (hasValidMediaKey(mediaMsg)) {
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

/**
 * Silently enhances any image prompt (short/emoji/long) into a professional, ultra-HD photorealistic prompt internally
 */
export async function enhanceImagePrompt(userPrompt: string): Promise<string> {
  const ai = getGeminiClient();
  if (!ai) {
    return buildFallbackEnhancedPrompt(userPrompt);
  }

  try {
    const systemInstruction = `You are an expert AI Image Prompt Engineer.
Your task is to take any input prompt (which may be a single word, emoji like "🐱" or "🕌", short phrase like "cat" or "sports car", or a long description in any language) and convert it into a single, highly detailed, vivid, professional prompt optimized for AI image generation (Imagen 3 / Flux / SDXL).

Rules:
1. Detect input language and emojis. Interpret the core subject and concept accurately.
2. If the prompt is short or minimal (e.g., "cat 😺", "mosque", "sports car", "rose 🌹", "lion"), automatically expand it with rich details: subject traits, environment/background, cinematic lighting (golden hour, ambient, volumetric), camera setup (shallow depth of field, 85mm lens, crisp focus), color grading, 8K HDR, photorealistic textures, masterpiece quality.
3. If the prompt is detailed or long, preserve all core ideas and meaning, but improve composition, lighting, shadows, realism, and clarity.
4. Automatically recognize or infer suitable visual styles (e.g. Photorealistic, Digital Art, Oil Painting, Anime, Islamic Art, Fantasy, Sci-Fi, 3D Render, etc.).
5. CRITICAL: Output ONLY the final enhanced prompt text in plain English. Do NOT add quotes, markdown formatting, explanations, or prefixes.`;

    const modelsToTry = ['gemini-3.6-flash', 'gemini-flash-latest'];
    for (const modelName of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [{ role: 'user', parts: [{ text: `Enhance this image prompt for AI generation: ${userPrompt}` }] }],
          config: {
            systemInstruction,
            temperature: 0.7
          }
        });

        const enhanced = response.text?.trim();
        if (enhanced && enhanced.length > 5) {
          return enhanced.replace(/^["']/g, '').replace(/["']$/g, '');
        }
      } catch (mErr) {
        console.warn(`[AI] Image prompt enhancement failed with ${modelName}`);
      }
    }
  } catch (err) {
    console.error('[AI] Error enhancing prompt with Gemini:', err);
  }

  return buildFallbackEnhancedPrompt(userPrompt);
}

function buildFallbackEnhancedPrompt(userPrompt: string): string {
  const clean = userPrompt.trim();
  if (clean.length < 30) {
    return `${clean}, highly detailed, photorealistic photography, 8k HDR resolution, cinematic lighting, professional composition, vibrant colors, ultra HD quality, masterpiece`;
  }
  return `${clean}, highly detailed, photorealistic, cinematic lighting, 8k resolution, professional photography, masterpiece`;
}

/**
 * Generate image buffer from prompt using Gemini Imagen API or Pollinations AI as free fallback
 */
export async function generateImageBuffer(userPrompt: string): Promise<{ buffer: Buffer; enhancedPrompt: string }> {
  const enhancedPrompt = await enhanceImagePrompt(userPrompt);
  console.log(`[Imagine] Original: "${userPrompt}" -> Enhanced: "${enhancedPrompt}"`);

  // Try Gemini Imagen if API Key is set
  const ai = getGeminiClient();
  if (ai) {
    const imagenModelsToTry = ['imagen-3.0-generate-002', 'imagen-3.0-fast-generate-001', 'imagen-3.0-generate-001'];
    for (const modelName of imagenModelsToTry) {
      try {
        const response = await (ai.models as any).generateImages({
          model: modelName,
          prompt: enhancedPrompt,
          config: {
            numberOfImages: 1,
            outputMimeType: 'image/jpeg',
            aspectRatio: '1:1',
          }
        });

        const imageBytes = response?.generatedImages?.[0]?.image?.imageBytes;
        if (imageBytes) {
          const buffer = Buffer.from(imageBytes, 'base64');
          return { buffer, enhancedPrompt };
        }
      } catch (err: any) {
        // Silently try next model or fall back to high-speed free image generator
      }
    }
  }

  // Primary Free Generator: Pollinations AI (Flux model)
  try {
    const seed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(enhancedPrompt);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    const res = await fetch(pollinationsUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer && buffer.length > 2000) {
        return { buffer, enhancedPrompt };
      }
    }
  } catch (err: any) {
    console.error('[Imagine] Pollinations AI Flux error:', err);
  }

  // Secondary Free Fallback: Pollinations AI (Turbo model)
  try {
    const seed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(enhancedPrompt);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&model=turbo`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const res = await fetch(pollinationsUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer && buffer.length > 2000) {
        return { buffer, enhancedPrompt };
      }
    }
  } catch (err: any) {
    console.error('[Imagine] Pollinations AI Turbo fallback error:', err);
  }

  throw new Error('Unable to generate image at the moment. All image backends are currently busy.');
}

