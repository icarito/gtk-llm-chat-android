import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'error';
  content: string;
  isStreaming?: boolean;
}

export function MessageBubble({ role, content, isStreaming }: MessageBubbleProps) {
  const isUser = role === 'user';
  const isError = role === 'error';

  return (
    <View style={[styles.container, isUser ? styles.containerRight : styles.containerLeft]}>
      <View
        style={[
          styles.bubble,
          isError
            ? styles.errorBubble
            : isUser
              ? styles.userBubble
              : styles.assistantBubble,
        ]}
      >
        {isError ? (
          <Text style={styles.errorText}>{content}</Text>
        ) : (
          <Text style={[styles.text, isUser ? styles.userText : styles.assistantText]}>
            {content}
            {isStreaming && <Text style={styles.cursor}> ▌</Text>}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  containerRight: {
    justifyContent: 'flex-end',
  },
  containerLeft: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    padding: 12,
    borderRadius: 12,
  },
  userBubble: {
    backgroundColor: '#1E4A6E',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: '#1A2838',
    borderBottomLeftRadius: 4,
  },
  errorBubble: {
    backgroundColor: '#3A1A1A',
    borderWidth: 1,
    borderColor: '#FF5252',
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
  },
  userText: {
    color: '#E0E0E0',
  },
  assistantText: {
    color: '#D0D8E0',
  },
  errorText: {
    color: '#FF5252',
    fontSize: 14,
  },
  cursor: {
    color: '#4FC3F7',
  },
});
