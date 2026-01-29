
import React, { useState, useEffect, useRef } from 'react';
import { Send, Plus, MessageSquare, Trash2, Menu, Sparkles, LogOut, Facebook, Zap, RefreshCcw, Settings, Mail, CheckCircle2, ShieldAlert, Calendar, Instagram, UserCircle, Heart, ExternalLink, Globe, Image as ImageIcon, AlertCircle } from 'lucide-react';
import { ChatSession, Message, UserProfile, Gender } from './types';
import { streamChatResponse, checkApiHealth } from './services/geminiService';
import * as db from './services/firebaseService';

const App: React.FC = () => {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [apiStatusText, setApiStatusText] = useState<string>('Ready');
  const [connectionHealth, setConnectionHealth] = useState<'perfect' | 'error'>('perfect');
  const [isSyncing, setIsSyncing] = useState(false);
  
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 4>(1);
  const [tempAge, setTempAge] = useState<string>('');
  const [tempGender, setTempGender] = useState<Gender | null>(null);
  const [customKeyInput, setCustomKeyInput] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessions, activeSessionId, isLoading]);

  useEffect(() => {
    const bootApp = async () => {
      const localProfileStr = localStorage.getItem('utsho_profile');
      if (localProfileStr) {
        const localProfile = JSON.parse(localProfileStr) as UserProfile;
        setUserProfile(localProfile);
        setCustomKeyInput(localProfile.customApiKey || '');
        setOnboardingStep(4);
        
        if (db.isDatabaseEnabled()) {
          setIsSyncing(true);
          try {
            const cloudProfile = await db.getUserProfile(localProfile.email);
            if (cloudProfile) setUserProfile(cloudProfile);
            const cloudSessions = await db.getSessions(localProfile.email);
            setSessions(cloudSessions);
            if (cloudSessions.length > 0) setActiveSessionId(cloudSessions[0].id);
          } finally {
            setIsSyncing(false);
          }
        }
        await performHealthCheck(localProfile);
      }
    };
    bootApp();
  }, []);

  const handleGoogleLogin = async () => {
    const googleUser = await db.loginWithGoogle();
    if (googleUser) {
      const cloud = await db.getUserProfile(googleUser.email);
      if (cloud) {
        setUserProfile(cloud);
        localStorage.setItem('utsho_profile', JSON.stringify(cloud));
        setOnboardingStep(4);
        const s = await db.getSessions(googleUser.email);
        setSessions(s);
        if (s.length > 0) setActiveSessionId(s[0].id); else createNewSession(googleUser.email);
      } else {
        setUserProfile(googleUser);
        setOnboardingStep(2);
      }
    }
  };

  const finalizePersonalization = async () => {
    if (!userProfile || !tempGender) return;
    const final: UserProfile = { ...userProfile, age: parseInt(tempAge) || 20, gender: tempGender };
    setUserProfile(final);
    localStorage.setItem('utsho_profile', JSON.stringify(final));
    if (db.isDatabaseEnabled()) await db.saveUserProfile(final);
    setOnboardingStep(4);
    createNewSession(final.email);
    await performHealthCheck(final);
  };

  const performHealthCheck = async (profile?: UserProfile) => {
    setApiStatusText('Scanning Nodes...');
    const { healthy } = await checkApiHealth(profile || userProfile || undefined);
    setConnectionHealth(healthy ? 'perfect' : 'error');
    setApiStatusText(healthy ? 'Active' : 'Node Error');
  };

  const saveSettings = async () => {
    if (!userProfile) return;
    const updated = { ...userProfile, customApiKey: customKeyInput.trim() };
    setUserProfile(updated);
    localStorage.setItem('utsho_profile', JSON.stringify(updated));
    if (db.isDatabaseEnabled()) await db.saveUserProfile(updated);
    setIsSettingsOpen(false);
    await performHealthCheck(updated);
  };

  const createNewSession = (emailOverride?: string) => {
    const sid = crypto.randomUUID();
    const newSession = { id: sid, title: 'New Chat', messages: [], createdAt: new Date() };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(sid);
    if (db.isDatabaseEnabled()) db.saveSession(emailOverride || userProfile!.email, newSession);
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || isLoading || !activeSessionId || !userProfile) return;
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: inputText, timestamp: new Date() };
    const currentSession = sessions.find(s => s.id === activeSessionId)!;
    const history = [...currentSession.messages, userMsg];
    
    setInputText('');
    setIsLoading(true);
    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages: history } : s));

    await streamChatResponse(
      history,
      userProfile,
      () => {},
      (fullText, sources, imageUrl) => {
        setIsLoading(false);
        const parts = fullText.split('[SPLIT]').map(p => p.trim()).filter(p => p.length > 0);
        const newMessages: Message[] = parts.map((p, i) => ({
          id: crypto.randomUUID(),
          role: 'model',
          content: p,
          timestamp: new Date(),
          sources: i === parts.length - 1 ? sources : undefined,
          imageUrl: i === 0 ? imageUrl : undefined
        }));
        
        const updatedMessages = [...history, ...newMessages];
        setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages: updatedMessages, title: s.messages.length === 0 ? userMsg.content.slice(0, 30) : s.title } : s));
        if (db.isDatabaseEnabled()) db.updateSessionMessages(userProfile.email, activeSessionId, updatedMessages);
      },
      (err) => {
        setIsLoading(false);
        let errorContent = "Something went wrong. Please check your internet connection.";
        const errMsg = err.message || "";
        if (errMsg.includes("429") || errMsg.includes("quota")) {
          errorContent = "All available nodes are currently at capacity. Please try again in a moment or add a personal API key in settings.";
        } else if (errMsg.includes("401") || errMsg.includes("API key")) {
          errorContent = "The system's API access appears to be invalid. Contact Shakkhor Paul.";
        }

        const errorMsg: Message = { id: crypto.randomUUID(), role: 'model', content: errorContent, timestamp: new Date() };
        setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages: [...s.messages, errorMsg] } : s));
      },
      (status) => setApiStatusText(status)
    );
  };

  const isUserDebi = userProfile?.email.toLowerCase().trim() === 'nitebiswaskotha@gmail.com';
  const activeSession = sessions.find(s => s.id === activeSessionId);

  if (onboardingStep === 1) return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-[3rem] p-12 shadow-2xl space-y-8 text-center">
        <div className="w-20 h-20 bg-indigo-600 rounded-3xl mx-auto flex items-center justify-center text-white floating-ai shadow-[0_0_20px_rgba(79,70,229,0.3)]"><Sparkles size={40} /></div>
        <div className="space-y-2">
          <h1 className="text-3xl font-black">Utsho AI</h1>
          <p className="text-zinc-500">Node-Pooled Intelligence • Real-time News</p>
        </div>
        <button onClick={handleGoogleLogin} className="w-full bg-white text-zinc-950 font-bold py-4 rounded-2xl flex items-center justify-center gap-3 active:scale-95 transition-all">
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5 h-5" alt="" /> Sign in with Google
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-['Hind_Siliguri',_sans-serif]">
      {isSettingsOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm bg-black/50">
           <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl w-full max-w-md space-y-6 shadow-2xl">
              <h3 className="text-xl font-bold flex items-center gap-2"><Settings size={20} className="text-indigo-500" /> Settings</h3>
              <div className="space-y-2">
                 <label className="text-xs font-bold text-zinc-500">PERSONAL GEMINI API KEY</label>
                 <input type="password" value={customKeyInput} onChange={e => setCustomKeyInput(e.target.value)} placeholder="Paste key here..." className="w-full bg-zinc-800 border border-zinc-700 p-4 rounded-xl outline-none focus:border-indigo-500" />
                 <p className="text-[10px] text-zinc-500">Provide your own key to bypass shared node limits.</p>
              </div>
              <div className="flex gap-3">
                 <button onClick={() => setIsSettingsOpen(false)} className="flex-1 py-3 font-bold border border-zinc-700 rounded-xl hover:bg-zinc-800">Cancel</button>
                 <button onClick={saveSettings} className="flex-1 py-3 font-bold bg-indigo-600 rounded-xl hover:bg-indigo-700">Save Changes</button>
              </div>
           </div>
        </div>
      )}

      {/* Sidebar */}
      <aside className={`fixed md:relative z-50 inset-y-0 left-0 w-72 bg-zinc-900 border-r border-zinc-800 flex flex-col transition-transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-4 flex flex-col gap-4">
          <button onClick={() => createNewSession()} className="bg-zinc-100 text-zinc-950 py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg"><Plus size={18} /> New Chat</button>
          <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 rounded-xl border border-zinc-800">
             <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${connectionHealth === 'perfect' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400">{apiStatusText}</span>
             </div>
             <button onClick={() => setIsSettingsOpen(true)} className="text-zinc-600 hover:text-indigo-400"><Settings size={14} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {sessions.map(s => (
            <div key={s.id} onClick={() => { setActiveSessionId(s.id); if(window.innerWidth < 768) setIsSidebarOpen(false); }} className={`group flex items-center gap-3 p-3 rounded-2xl cursor-pointer ${activeSessionId === s.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/40 text-zinc-500'}`}>
              <MessageSquare size={16} /> <div className="flex-1 truncate text-sm font-medium">{s.title}</div>
              <button onClick={(e) => { e.stopPropagation(); db.deleteSession(userProfile!.email, s.id); setSessions(prev => prev.filter(x => x.id !== s.id)); }} className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-zinc-800 flex items-center gap-3">
          <img src={userProfile?.picture} className="w-9 h-9 rounded-full border border-zinc-700" alt="" />
          <div className="flex-1 truncate text-[11px] font-bold tracking-tight text-zinc-400">{userProfile?.name}</div>
          <button onClick={() => { localStorage.clear(); window.location.reload(); }} className="text-zinc-600 hover:text-red-500"><LogOut size={16} /></button>
        </div>
      </aside>

      {/* Main Chat */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        <div className="md:hidden h-14 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md flex items-center px-4 sticky top-0 z-40">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 -ml-2 text-zinc-400"><Menu size={20} /></button>
          <div className="flex-1 text-center font-black tracking-tighter">UTSHO</div>
          <div className="w-8" />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-8">
          <div className="max-w-3xl mx-auto space-y-6">
            {!activeSession || activeSession.messages.length === 0 ? (
              <div className="h-[60vh] flex flex-col items-center justify-center space-y-4 text-center">
                <div className={`w-20 h-20 rounded-3xl flex items-center justify-center shadow-2xl floating-ai ${isUserDebi ? 'bg-pink-600 shadow-pink-500/20' : 'bg-indigo-600 shadow-indigo-500/20'}`}><Sparkles size={32} /></div>
                <h3 className="text-2xl font-black">Ready to chat, {userProfile?.name.split(' ')[0]}?</h3>
                <p className="text-sm max-w-xs text-zinc-500">I use a pooled API system to stay online as much as possible.</p>
              </div>
            ) : (
              activeSession.messages.map(m => (
                <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : 'flex-row'} animate-in slide-in-from-bottom-2 duration-300`}>
                   <div className={`flex flex-col gap-2 max-w-[85%] ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                      {m.imageUrl && (
                        <div className="rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl mb-2 hover:scale-[1.01] transition-transform">
                           <img src={m.imageUrl} className="max-w-full h-auto" alt="AI Visual" />
                        </div>
                      )}
                      <div className={`p-4 rounded-2xl text-[15px] bangla-text shadow-sm ${m.role === 'user' ? (isUserDebi ? 'bg-pink-600' : 'bg-indigo-600 shadow-indigo-500/10') + ' text-white rounded-tr-none' : 'bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-tl-none'} ${m.content.includes("capacity") ? 'border-red-500/30 bg-red-500/5' : ''}`}>
                        {m.content.includes("capacity") && <AlertCircle size={14} className="inline mr-2 text-red-400" />}
                        {m.content}
                      </div>
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-2 space-y-2 w-full">
                          <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-500 uppercase tracking-widest pl-1">
                            <Globe size={10} className="text-indigo-400" /> Research Data
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {m.sources.map((s: any, idx: number) => (
                              <a key={idx} href={s.uri} target="_blank" className="flex items-center gap-1.5 bg-zinc-900/50 border border-zinc-800 py-1.5 px-3 rounded-xl text-[11px] text-zinc-400 hover:text-white hover:bg-zinc-800 transition-all">
                                <ExternalLink size={10} className="text-zinc-600" /> 
                                <span className="max-w-[140px] truncate">{s.title}</span>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                   </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Area */}
        <div className="p-4 md:p-8 bg-zinc-950/80 backdrop-blur-md">
          <div className="max-w-3xl mx-auto flex items-end gap-2 bg-zinc-900 border border-zinc-800 rounded-3xl p-1.5 focus-within:border-indigo-500/50 shadow-2xl transition-all">
            <textarea rows={1} value={inputText} onChange={e => { setInputText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }} placeholder="Message Utsho..." className="flex-1 bg-transparent py-3 px-5 outline-none resize-none max-h-40 text-zinc-100" />
            <button onClick={handleSendMessage} disabled={!inputText.trim() || isLoading} className={`p-3 rounded-full transition-all active:scale-90 ${inputText.trim() && !isLoading ? (isUserDebi ? 'bg-pink-600' : 'bg-indigo-600 shadow-indigo-600/20') : 'bg-zinc-800 text-zinc-600'}`}>
               {isLoading ? <RefreshCcw size={20} className="animate-spin" /> : <Send size={20} />}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
