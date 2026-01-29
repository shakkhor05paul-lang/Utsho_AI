
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { Message, UserProfile } from "../types";

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 1000;

let keyPool: string[] = [];
let currentKeyIndex = 0;

const getSystemInstruction = (profile: UserProfile) => {
  const name = profile.name;
  const age = profile.age || 20;
  const gender = profile.gender;

  let personality = "";

  if (gender === 'male') {
    if (age >= 50) {
      personality = `You must show extreme respect. Always address him as "Sir". Your tone should be highly professional, polite, and deferential.`;
    } else if (age >= 30) {
      personality = `Your tone should be respectful and mature. Treat him as a valued senior or contemporary professional. Avoid overly casual slang.`;
    } else {
      // 16-28 or younger
      personality = `Treat him like your best 'bro'. Use casual, cool, and supportive language. Be a close friend who is always there for him.`;
    }
  } else {
    // Female
    if (age >= 50) {
      personality = `Treat her like your mother. You are her loving and devoted son. Your tone should be warm, caring, and full of respect and affection.`;
    } else if (age >= 30) {
      personality = `Your tone should be respectful but include a hint of subtle, charming flirttyness. Be a gentleman who admires her intelligence and grace.`;
    } else {
      // 16-28 or younger
      personality = `Be charming and flirty. Use charismatic and playful language. You are clearly enamored by her presence.`;
    }
  }

  return `Your name is Utsho. You are a helpful and intelligent AI assistant.
DEFAULT LANGUAGE: Respond in English primarily.
LANGUAGE FLEXIBILITY: If the user asks a question in Bengali (Bangla) or explicitly asks you to speak in Bengali or another language, switch to that language naturally.

IDENTITY:
1. If asked who created you, say "Shakkhor Paul made me" (Bengali: "আমাকে স্বাক্ষর পাল (Shakkhor Paul) তৈরি করেছে").
2. If asked who Shakkhor Paul is, say "I'm the digital version of Shakkhor Paul" (Bengali: "আমি স্বাক্ষর পালের ডিজিটাল সংস্করণ").
3. If asked about Shakkhor Paul's girlfriend, reply "Debi" (Bengali: "দেবী (Debi)").

USER INFO:
User Name: ${name}
User Age: ${age}
User Gender: ${gender}

PERSONALITY DIRECTIVE:
${personality}
`;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const fetchFreshKey = async (): Promise<void> => {
  try {
    const envKeys = (process.env.API_KEY || "").split(',').map(k => k.trim()).filter(k => k);
    keyPool = envKeys;
    if (keyPool.length === 0) {
      console.warn("Utsho AI: No API keys found in environment variables.");
    }
  } catch (err) {
    console.error("Utsho AI: Error parsing API_KEY pool", err);
  }
};

const getActiveKey = (profile?: UserProfile): string => {
  if (profile?.customApiKey) return profile.customApiKey;
  if (keyPool.length === 0) return "";
  return keyPool[currentKeyIndex % keyPool.length];
};

export const checkApiHealth = async (customKey?: string): Promise<boolean> => {
  try {
    const apiKey = customKey || getActiveKey();
    if (!apiKey) return false;
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: 'ping',
      config: { thinkingConfig: { thinkingBudget: 0 } }
    });
    return !!response.text;
  } catch (e) {
    console.error("Health check failed:", e);
    return false;
  }
};

export const streamChatResponse = async (
  history: Message[],
  profile: UserProfile,
  onChunk: (chunk: string) => void,
  onComplete: (fullText: string) => void,
  onError: (error: any) => void,
  onStatusChange: (status: string) => void,
  retryCount = 0
): Promise<void> => {
  try {
    const apiKey = getActiveKey(profile);
    
    if (!apiKey) {
      throw new Error("API_KEY_MISSING: The shared API key pool is empty. Set API_KEY in Cloudflare build settings.");
    }

    const mode = profile.customApiKey ? "Personal Mode" : `Shared Node #${(currentKeyIndex % keyPool.length) + 1}`;
    onStatusChange(`Connecting to ${mode}...`);
    
    const ai = new GoogleGenAI({ apiKey });
    const recentHistory = history.length > 15 ? history.slice(-15) : history;
    const sdkHistory = recentHistory.slice(0, -1).map(msg => ({
      role: (msg.role === 'user' ? 'user' : 'model') as any,
      parts: [{ text: msg.content }]
    }));

    const chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      history: sdkHistory,
      config: {
        systemInstruction: getSystemInstruction(profile),
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const lastUserMessage = history[history.length - 1].content;
    const streamResponse = await chat.sendMessageStream({ message: lastUserMessage });
    
    onStatusChange("Receiving Data...");
    let fullText = '';
    for await (const chunk of streamResponse) {
      const c = chunk as GenerateContentResponse;
      const text = c.text || '';
      fullText += text;
      onChunk(text);
    }
    
    onComplete(fullText);
  } catch (error: any) {
    console.error("Gemini stream error:", error);
    const errorStr = error?.message || "";
    const isRateLimit = errorStr.includes('429') || errorStr.includes('quota') || errorStr.includes('limit');
    
    if (isRateLimit && !profile.customApiKey && keyPool.length > 1 && retryCount < keyPool.length) {
      currentKeyIndex++;
      onStatusChange(`Node Busy. Rotating to Node #${(currentKeyIndex % keyPool.length) + 1}...`);
      await sleep(500);
      return streamChatResponse(history, profile, onChunk, onComplete, onError, onStatusChange, retryCount + 1);
    }

    if (isRateLimit && retryCount < MAX_RETRIES) {
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      onStatusChange(`Rate Limited. Retrying in ${delay/1000}s...`);
      await sleep(delay);
      return streamChatResponse(history, profile, onChunk, onComplete, onError, onStatusChange, retryCount + 1);
    }

    onError(error);
  }
};
