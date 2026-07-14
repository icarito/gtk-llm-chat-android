import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{content}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 1,
  },
  text: {
    color: '#D0D8E0',
    fontSize: 15,
    lineHeight: 22,
  },
});
