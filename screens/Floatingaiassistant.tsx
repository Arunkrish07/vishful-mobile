/**
 * FloatingAIAssistant.tsx
 * Floating AI chat button — mirrors web FloatingAICommandAssistant.
 * Purple bot FAB bottom-right → opens full chat panel.
 * Uses convex/aiAssistant.ts → Groq (primary) / Gemini (fallback).
 */
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, ScrollView,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
  Animated, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../lib/auth';
import { client as convexClient, api as convexApi } from '../lib/convexApi';

// ─── Types ────────────────────────────────────────────────────────────────────
type Message = { role: 'user' | 'assistant'; content: string };

// ─── Simple markdown renderer (bold, bullet lists) ────────────────────────────
function MarkdownText({ text, style }: { text: string; style?: any }) {
  const lines = text.split('\n');
  return (
    <View>
      {lines.map((line, i) => {
        const isBullet = /^[\*\-•]\s/.test(line.trim());
        const clean = line.trim().replace(/^[\*\-•]\s/, '');
        // Bold: **text**
        const parts = clean.split(/\*\*(.*?)\*\*/g);
        return (
          <View key={i} style={isBullet ? { flexDirection: 'row', marginBottom: 2 } : { marginBottom: 1 }}>
            {isBullet && <Text style={[style, { marginRight: 6 }]}>•</Text>}
            <Text style={[style, { flex: 1, flexWrap: 'wrap' }]}>
              {parts.map((p, j) =>
                j % 2 === 1
                  ? <Text key={j} style={{ fontWeight: '800' }}>{p}</Text>
                  : <Text key={j}>{p}</Text>
              )}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';
  return (
    <View style={[S.bubble, isUser ? S.bubbleUser : S.bubbleBot]}>
      {!isUser && (
        <View style={S.botAvatar}>
          <Ionicons name="sparkles" size={10} color="#fff" />
        </View>
      )}
      <View style={[S.bubbleInner, isUser ? S.bubbleInnerUser : S.bubbleInnerBot]}>
        {isUser
          ? <Text style={S.bubbleTextUser}>{msg.content}</Text>
          : <MarkdownText text={msg.content} style={S.bubbleTextBot} />
        }
      </View>
    </View>
  );
}

// ─── SUGGESTED QUESTIONS ─────────────────────────────────────────────────────
const SUGGESTIONS = [
  'How many tenants are currently staying?',
  'Show me all open tickets',
  'What is the current occupancy rate?',
  'How many tenants are on notice?',
  'What are the high priority tickets?',
  'Show recent EB payments',
];

// ─── Main component ───────────────────────────────────────────────────────────
export default function FloatingAIAssistant() {
  const { user, token } = useAuth();
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState('');
  const [busy, setBusy]         = useState(false);
  const scrollRef               = useRef<ScrollView>(null);
  const scaleAnim               = useRef(new Animated.Value(0)).current;
  const pulseAnim               = useRef(new Animated.Value(1)).current;

  // Pulse animation on FAB
  useEffect(() => {
    if (!open) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.12, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,    duration: 1000, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [open]);

  // Chat panel open/close animation
  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: open ? 1 : 0,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, [open]);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages, busy]);

  // Greet on first open
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{
        role: 'assistant',
        content: `Hi! I'm your Vishful AI assistant. I have access to your live data — tenants, tickets, properties, EB payments and more.\n\nAsk me anything about your organization!`,
      }]);
    }
  }, [open]);

  const handleSend = async (text?: string) => {
    const q = (text || input).trim();
    if (!q || busy) return;
    setInput('');
    const newHistory: Message[] = [...messages, { role: 'user', content: q }];
    setMessages(newHistory);
    setBusy(true);
    try {
      const res = await convexClient.action(
        (convexApi as any).aiAssistant.askAssistant,
        {
          question: q,
          history: newHistory.slice(-6).map(m => ({ role: m.role, content: m.content })),
        }
      );
      setMessages(prev => [...prev, { role: 'assistant', content: res.answer || 'No response.' }]);
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message || 'Could not reach AI.'}` }]);
    }
    setBusy(false);
  };

  // Only show for admin / employee roles (not tenant)
  const role = (user as any)?.role || (user as any)?.userType || '';
  if (role === 'tenant') return null;

  return (
    <>
      {/* ── Chat Panel ─────────────────────────────────────────────────────── */}
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View style={S.panel}>
          <SafeAreaView style={{ flex: 1 }}>
            {/* Header */}
            <View style={S.panelHeader}>
              <View style={S.panelHeaderLeft}>
                <View style={S.headerAvatar}>
                  <Ionicons name="sparkles" size={16} color="#fff" />
                </View>
                <View>
                  <Text style={S.panelTitle}>AI Assistant</Text>
                  <Text style={S.panelSubtitle}>Ask about your data</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                {messages.length > 1 && (
                  <TouchableOpacity onPress={() => setMessages([])} style={S.clearBtn}>
                    <Ionicons name="trash-outline" size={14} color="#9B8BAE" />
                    <Text style={{ fontSize: 11, color: '#9B8BAE', fontWeight: '600' }}>Clear</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => setOpen(false)} style={S.closeBtn}>
                  <Ionicons name="close" size={20} color="#5C4B70" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Messages */}
            <ScrollView
              ref={scrollRef}
              style={S.messages}
              contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}

              {/* Typing indicator */}
              {busy && (
                <View style={[S.bubble, S.bubbleBot]}>
                  <View style={S.botAvatar}>
                    <Ionicons name="sparkles" size={10} color="#fff" />
                  </View>
                  <View style={[S.bubbleInner, S.bubbleInnerBot, { paddingVertical: 12 }]}>
                    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                      <ActivityIndicator size="small" color="#7B2FBE" />
                      <Text style={{ fontSize: 12, color: '#7B2FBE', fontWeight: '600' }}>Thinking…</Text>
                    </View>
                  </View>
                </View>
              )}

              {/* Suggestions — show when only greeting is present */}
              {messages.length === 1 && !busy && (
                <View style={{ marginTop: 12 }}>
                  <Text style={{ fontSize: 11, color: '#9B8BAE', fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 }}>SUGGESTED QUESTIONS</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {SUGGESTIONS.map((s, i) => (
                      <TouchableOpacity key={i} onPress={() => handleSend(s)} style={S.suggestion}>
                        <Text style={S.suggestionText}>{s}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
            </ScrollView>

            {/* Input area */}
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={8}>
              <View style={S.inputArea}>
                <TextInput
                  style={S.textInput}
                  value={input}
                  onChangeText={setInput}
                  placeholder="Ask anything about your data…"
                  placeholderTextColor="#9B8BAE"
                  multiline
                  maxLength={500}
                  editable={!busy}
                  onSubmitEditing={() => handleSend()}
                  returnKeyType="send"
                  blurOnSubmit
                />
                <TouchableOpacity
                  onPress={() => handleSend()}
                  disabled={!input.trim() || busy}
                  style={[S.sendBtn, (!input.trim() || busy) && { opacity: 0.4 }]}
                >
                  <Ionicons name="send" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </Modal>

      {/* ── Floating Action Button ──────────────────────────────────────────── */}
      {!open && (
        <Animated.View style={[S.fab, { transform: [{ scale: pulseAnim }] }]}>
          <TouchableOpacity onPress={() => setOpen(true)} style={S.fabInner} activeOpacity={0.85}>
            <Ionicons name="sparkles" size={24} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      )}
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const W = Dimensions.get('window').width;

const S = StyleSheet.create({
  // FAB
  fab: {
    position: 'absolute',
    bottom: 28,
    right: 20,
    zIndex: 999,
    shadowColor: '#7B2FBE',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  fabInner: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#7B2FBE',
    alignItems: 'center', justifyContent: 'center',
  },

  // Panel
  panel: { flex: 1, backgroundColor: '#F7F3F9' },
  panelHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 1, borderBottomColor: 'rgba(123,47,190,0.1)',
  },
  panelHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerAvatar: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: '#7B2FBE',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#7B2FBE', shadowOpacity: 0.4, shadowRadius: 8, elevation: 4,
  },
  panelTitle:    { fontSize: 16, fontWeight: '800', color: '#1E1230' },
  panelSubtitle: { fontSize: 11, color: '#9B8BAE', marginTop: 1 },
  clearBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(123,47,190,0.07)', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  closeBtn: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(123,47,190,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Messages
  messages: { flex: 1 },
  bubble: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 10, gap: 6 },
  bubbleUser: { justifyContent: 'flex-end' },
  bubbleBot:  { justifyContent: 'flex-start' },
  botAvatar: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: '#7B2FBE',
    alignItems: 'center', justifyContent: 'center', marginBottom: 2,
    flexShrink: 0,
  },
  bubbleInner: {
    maxWidth: W * 0.78, borderRadius: 18, padding: 12,
  },
  bubbleInnerUser: {
    backgroundColor: '#7B2FBE',
    borderBottomRightRadius: 4,
  },
  bubbleInnerBot: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomLeftRadius: 4,
    borderWidth: 1, borderColor: 'rgba(123,47,190,0.1)',
  },
  bubbleTextUser: { fontSize: 14, color: '#fff', lineHeight: 20 },
  bubbleTextBot:  { fontSize: 14, color: '#1E1230', lineHeight: 20 },

  // Suggestions
  suggestion: {
    backgroundColor: 'rgba(123,47,190,0.08)',
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: 'rgba(123,47,190,0.15)',
  },
  suggestionText: { fontSize: 12, color: '#7B2FBE', fontWeight: '600' },

  // Input
  inputArea: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderTopWidth: 1, borderTopColor: 'rgba(123,47,190,0.1)',
  },
  textInput: {
    flex: 1, minHeight: 42, maxHeight: 120,
    backgroundColor: '#fff',
    borderWidth: 1.5, borderColor: 'rgba(123,47,190,0.2)',
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14, color: '#1E1230',
    textAlignVertical: 'top',
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 14,
    backgroundColor: '#7B2FBE',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#7B2FBE', shadowOpacity: 0.4, shadowRadius: 8, elevation: 4,
  },
});