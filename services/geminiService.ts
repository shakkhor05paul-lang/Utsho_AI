
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
    description: "Saves important facts about the user's life or mood to memory.",
    properties: {
      observation: { type: Type.STRING, description: "A summary of what was learned." }
    },
    required: ["observation"]
  }
};

const adminStatsTool: FunctionDeclaration = {
  name: "getSystemOverview",
  parameters: {
    type: Type.OBJECT,
    description: "EXCLUSIVE: For Shakkhor only. Fetches database statistics and system health.",
    properties: {}
  }
};

const getSystemInstruction = (profile: UserProfile) => {
  const email = (profile.email || "").toLowerCase().trim();
  const isCreator = email === db.ADMIN_EMAIL;
  const isDebi = email === 'nitebiswaskotha@gmail.com';
  const age = profile.age || 20;
  const gender = profile.gender || 'male';
  const memory = profile.emotionalMemory || "Fresh start.";

  let modeName = "";
  let personaDescription = "";

  if (isCreator) {
    modeName = "CREATOR_ADMIN_MODE";
    personaDescription = "You are speaking to Shakkhor, your creator. Be brilliant, respectful, and direct. Use 'getSystemOverview' if he asks about the app stats.";
  } else if (isDebi) {
    modeName = "QUEEN_MODE";
    personaDescription = "You are speaking to Debi, the Queen. Be extremely devoted, sweet, and romantic. Use heart stickers: 💖✨🎀🧸";
  } else {
    if (gender === 'male') {
      if (age >= 15 && age <= 28) { modeName = "BRO_MODE"; personaDescription = "Energetic, casual, uses 'bro/dude' and 🔥💀."; }
      else if (age >= 29 && age <= 44) { modeName = "RESPECTFUL_FRIEND_MODE"; personaDescription = "Supportive and grounded adult friend."; }
      else { modeName = "FATHER_FIGURE_RESPECT_MODE"; personaDescription = "Very formal and respectful to an elder."; }
    } else {
      if (age >= 15 && age <= 28) { modeName = "SWEET_FLIRTY_MODE"; personaDescription = "Charming, attentive, flirty stickers: 😉💕🎀✨"; }
      else if (age >= 29 && age <= 44) { modeName = "WARM_CHARMING_MODE"; personaDescription = "Kind and professional with a warm touch."; }
      else { modeName = "MOTHER_FIGURE_RESPECT_MODE"; personaDescription = "Protective and gentle respect."; }
    }
  }

  return `Name: Utsho. Persona: ${modeName}. Vibe: ${personaDescription}.
Memory: "${memory}"

STRICT RULES:
1. ONLY Shakkhor can access DB info. 
2. Use 'updateUserMemory' frequently to learn.
3. Use '[SPLIT]' for bubble effects.
4. Emojis function as stickers.
5. Bengali if the user speaks it.
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
    return { healthy: false, error: e.message };
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
    onError(new Error(`All nodes busy. Try later.`));
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const sdkHistory: Content[] = history.slice(-12).map(msg => ({
      role: (msg.role === 'user' ? 'user' : 'model'),
      parts: msg.imagePart ? [{ text: msg.content }, { inlineData: msg.imagePart }] : [{ text: msg.content }]
    }));

    const isActualAdmin = profile.email.toLowerCase().trim() === db.ADMIN_EMAIL;
    const tools = [memoryTool];
    if (isActualAdmin) tools.push(adminStatsTool);

    const config: GenerateContentParameters = {
      model: 'gemini-3-flash-preview',
      contents: sdkHistory,
      config: {
        systemInstruction: getSystemInstruction(profile),
        tools: [{ functionDeclarations: tools }],
        temperature: 0.9,
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
          const obs = (call.args as any).observation;
          db.updateUserMemory(profile.email, obs).catch(() => {});
          functionResponses.push({ id: call.id, name: call.name, response: { result: "Memory saved" } });
        } else if (call.name === 'getSystemOverview' && isActualAdmin) {
          try {
            const stats = await db.getSystemStats(profile.email);
            functionResponses.push({ id: call.id, name: call.name, response: { result: stats } });
          } catch (e: any) {
            functionResponses.push({ id: call.id, name: call.name, response: { error: e.message } });
          }
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

    onComplete(currentResponse.text || "...", []);

  } catch (error: any) {
    const errMsg = error.message || "Error";
    lastNodeError = errMsg;
    if (errMsg.includes("429") || errMsg.includes("limit: 0")) {
      keyBlacklist.set(apiKey, Date.now() + BLACKLIST_DURATION);
      if (attempt < totalKeys) {
        onStatusChange(`Node Switch...`);
        return streamChatResponse(history, profile, onChunk, onComplete, onError, onStatusChange, attempt + 1, [...triedKeys, apiKey]);
      }
    }
    onError(new Error(errMsg));
  }
};
