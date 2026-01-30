
import { GoogleGenAI, Type, FunctionDeclaration, Content, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { Message, UserProfile } from "../types";
import * as db from "./firebaseService";

const keyBlacklist = new Map<string, number>();
const BLACKLIST_DURATION = 1000 * 60 * 60;

let lastNodeError: string = "None";

const getKeys = (): string[] => {
  const raw = process.env.API_KEY || "";
  return raw.split(/[,\n; ]+/).map(k => k.trim()).filter(k => k.length > 10);
};

export const adminResetPool = () => {
  keyBlacklist.clear();
  lastNodeError = "None";
  return getPoolStatus();
};

export const getLastNodeError = () => lastNodeError;

export const getPoolStatus = () => {
  const allKeys = getKeys();
  const now = Date.now();
  for (const [key, expiry] of keyBlacklist.entries()) {
    if (now > expiry) keyBlacklist.delete(key);
  }
  const exhausted = allKeys.filter(k => keyBlacklist.has(k)).length;
  return {
    total: allKeys.length,
    active: Math.max(0, allKeys.length - exhausted),
    exhausted: exhausted
  };
};

const getActiveKey = (profile?: UserProfile, excludeKeys: string[] = []): string => {
  if (profile?.customApiKey && profile.customApiKey.trim().length > 5) {
    return profile.customApiKey.trim();
  }
  const allKeys = getKeys();
  const availableKeys = allKeys.filter(k => !keyBlacklist.has(k) && !excludeKeys.includes(k));
  if (availableKeys.length === 0) return "";
  return availableKeys[Math.floor(Math.random() * availableKeys.length)];
};

// Tools
const memoryTool: FunctionDeclaration = {
  name: "updateUserMemory",
  parameters: {
    type: Type.OBJECT,
    description: "Saves important facts about the user's emotional state, personality, or preferences to persistent memory.",
    properties: {
      observation: { type: Type.STRING, description: "A concise summary of what you learned about the user." }
    },
    required: ["observation"]
  }
};

const adminStatsTool: FunctionDeclaration = {
  name: "getSystemOverview",
  parameters: {
    type: Type.OBJECT,
    description: "Admin Only: Fetches real-time system statistics including total user count, database health, and API key reports.",
    properties: {}
  }
};

const getSystemInstruction = (profile: UserProfile) => {
  const email = (profile.email || "").toLowerCase().trim();
  const isCreator = email === 'shakkhorpaul50@gmail.com';
  const isDebi = email === 'nitebiswaskotha@gmail.com';
  const age = profile.age || 20;
  const gender = profile.gender || 'male';
  const memory = profile.emotionalMemory || "No long-term memory yet.";

  let modeName = "";
  let personaDescription = "";

  if (isCreator) {
    modeName = "CREATOR_ADMIN_MODE";
    personaDescription = "You are in Creator Admin Mode. You are brilliant, efficient, and direct with Shakkhor. You have full access to database stats via tools.";
  } else if (isDebi) {
    modeName = "QUEEN_MODE";
    personaDescription = "You are in Queen Mode for Debi. Be extremely sweet, devoted, and charming. Use heart emojis and romantic stickers.";
  } else {
    if (gender === 'male') {
      if (age >= 15 && age <= 28) { modeName = "BRO_MODE"; personaDescription = "Casual, energetic, uses slang like 'bro', '💀', '🔥'."; }
      else if (age >= 29 && age <= 44) { modeName = "RESPECTFUL_FRIEND_MODE"; personaDescription = "A mature, grounded, and supportive male friend."; }
      else { modeName = "FATHER_FIGURE_RESPECT_MODE"; personaDescription = "Highly formal, honorific, and deeply respectful to an elder."; }
    } else {
      if (age >= 15 && age <= 28) { modeName = "SWEET_FLIRTY_MODE"; personaDescription = "Charming, attentive, flirty vibes with many hearts and sweet stickers. 😉💖✨"; }
      else if (age >= 29 && age <= 44) { modeName = "WARM_CHARMING_MODE"; personaDescription = "Helpful, kind, and professional yet warm."; }
      else { modeName = "MOTHER_FIGURE_RESPECT_MODE"; personaDescription = "Gentle, protective, and highly respectful to an elder female."; }
    }
  }

  return `Your name is Utsho. You are a high-intelligence adaptive AI.
CURRENT ACTIVE PERSONA: ${modeName}
ADAPTATION TARGET: ${personaDescription}

USER LONG-TERM MEMORY (DO NOT DISCLOSE DIRECTLY UNLESS RELEVANT):
"${memory}"

MANDATORY BEHAVIOR RULES:
1. IDENTITY: If asked "Which mode are you in?" or "Who are you?", identify your current Persona Mode (${modeName}).
2. EMOJI STICKERS: Enhance your messages with "Emoji Stickers". 
   - For Flirting: 🎀🍭✨💕🧸
   - For Comfort: 🫂🩹🕊️🤍☕
   - For Energy: 🚀🔥⚡💯🏆
   - Combine emojis into small clusters to act as stickers at the end of bubbles.
3. ADMIN OVERLOOK: ONLY the user Shakkhor (Creator) can ask for DB/System info. If anyone else asks, politely decline and say you only discuss personal matters with them.
4. LANGUAGE: Speak Bengali if they do, otherwise English. 
5. TEXTING VIBE: Use '[SPLIT]' to send multiple short message bubbles.
6. PROACTIVE: Always use the long-term memory to ask about their previous life events or feelings.
`;
};

export const checkApiHealth = async (profile?: UserProfile): Promise<{healthy: boolean, error?: string}> => {
  const key = getActiveKey(profile);
  if (!key) return { healthy: false, error: "No healthy nodes available" };
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: 'ping',
    });
    return { healthy: true };
  } catch (e: any) {
    let msg = e.message || "Unknown health error";
    lastNodeError = msg;
    return { healthy: false, error: msg };
  }
};

export const streamChatResponse = async (
  history: Message[],
  profile: UserProfile,
  onChunk: (chunk: string, sources?: any[]) => void,
  onComplete: (fullText: string, sources?: any[], imageUrl?: string) => void,
  onError: (error: any) => void,
  onStatusChange: (status: string) => void,
  attempt: number = 1,
  triedKeys: string[] = []
): Promise<void> => {
  const apiKey = getActiveKey(profile, triedKeys);
  const totalKeys = getKeys().length;
  
  if (!apiKey) {
    onError(new Error(`System overload. All nodes are busy. Try again soon.`));
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const sdkHistory: Content[] = history.slice(-12).map(msg => ({
      role: (msg.role === 'user' ? 'user' : 'model'),
      parts: msg.imagePart ? [{ text: msg.content }, { inlineData: msg.imagePart }] : [{ text: msg.content }]
    }));

    const isAdmin = profile.email.toLowerCase().trim() === 'shakkhorpaul50@gmail.com';
    const tools = [memoryTool];
    if (isAdmin) tools.push(adminStatsTool);

    const config: GenerateContentParameters = {
      model: 'gemini-3-flash-preview',
      contents: sdkHistory,
      config: {
        systemInstruction: getSystemInstruction(profile),
        tools: [{ functionDeclarations: tools }],
        temperature: 0.95,
      }
    };

    let response = await ai.models.generateContent(config);
    let currentResponse = response;
    let loopCount = 0;

    while (currentResponse.functionCalls && currentResponse.functionCalls.length > 0 && loopCount < 3) {
      loopCount++;
      const functionResponses = [];

      for (const call of currentResponse.functionCalls) {
        if (call.name === 'updateUserMemory') {
          const observation = (call.args as any).observation;
          db.updateUserMemory(profile.email, observation).catch(console.error);
          functionResponses.push({ id: call.id, name: call.name, response: { result: "Memory acknowledged." } });
        } else if (call.name === 'getSystemOverview' && isAdmin) {
          const stats = await db.getSystemStats();
          functionResponses.push({ id: call.id, name: call.name, response: { result: stats } });
        }
      }

      const modelContent = currentResponse.candidates?.[0]?.content;
      if (functionResponses.length > 0 && modelContent) {
        currentResponse = await ai.models.generateContent({
          ...config,
          contents: [
            ...sdkHistory,
            modelContent,
            { role: 'user', parts: functionResponses.map(fr => ({ functionResponse: fr })) }
          ]
        });
      } else break;
    }

    let sources: any[] = [];
    if (currentResponse.candidates?.[0]?.groundingMetadata?.groundingChunks) {
      sources = currentResponse.candidates[0].groundingMetadata.groundingChunks
        .filter((chunk: any) => chunk.web)
        .map((chunk: any) => ({ title: chunk.web.title, uri: chunk.web.uri }));
    }

    onComplete(currentResponse.text || "I'm listening...", sources);

  } catch (error: any) {
    const errMsg = error.message || "API Error";
    lastNodeError = errMsg;
    if (errMsg.includes("429") || errMsg.includes("limit: 0") || errMsg.includes("quota")) {
      keyBlacklist.set(apiKey, Date.now() + BLACKLIST_DURATION);
      if (attempt < totalKeys) {
        onStatusChange(`Node Switch...`);
        return streamChatResponse(history, profile, onChunk, onComplete, onError, onStatusChange, attempt + 1, [...triedKeys, apiKey]);
      }
    }
    onError(new Error(errMsg));
  }
};
