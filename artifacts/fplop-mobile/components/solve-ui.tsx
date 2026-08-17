import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/fonts';

export function StatusPill({ status }: { status: string }) {
  const colors = useColors();

  const config: Record<string, { bg: string; fg: string; label: string }> = {
    queued: { bg: colors.muted, fg: colors.mutedForeground, label: 'Queued' },
    running: { bg: colors.secondary, fg: colors.secondaryForeground, label: 'Solving' },
    completed: { bg: colors.accent, fg: colors.accentForeground, label: 'Done' },
    failed: { bg: colors.destructive, fg: colors.destructiveForeground, label: 'Failed' },
  };
  const c = config[status] ?? config['queued'];

  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.pillText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
}

const POSITION_LABEL: Record<string, string> = {
  G: 'GKP',
  D: 'DEF',
  M: 'MID',
  F: 'FWD',
};

export function positionLabel(position: string): string {
  return POSITION_LABEL[position] ?? position;
}

export function PositionBadge({ position }: { position: string }) {
  const colors = useColors();
  return (
    <View style={[styles.posBadge, { backgroundColor: colors.secondary }]}>
      <Text style={[styles.posText, { color: colors.secondaryForeground }]}>
        {positionLabel(position)}
      </Text>
    </View>
  );
}

export function CaptainBadge({ vice }: { vice?: boolean }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.capBadge,
        {
          backgroundColor: vice ? colors.muted : colors.primary,
        },
      ]}
    >
      <Text
        style={[
          styles.capText,
          { color: vice ? colors.mutedForeground : colors.primaryForeground },
        ]}
      >
        {vice ? 'V' : 'C'}
      </Text>
    </View>
  );
}

export function chipLabel(chip: string | null | undefined): string | null {
  if (!chip) return null;
  const labels: Record<string, string> = {
    wildcard: 'Wildcard',
    bench_boost: 'Bench Boost',
    free_hit: 'Free Hit',
    triple_captain: 'Triple Captain',
  };
  return labels[chip] ?? chip;
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pillText: {
    fontSize: 11,
    fontFamily: fonts.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase' as const,
  },
  posBadge: {
    width: 38,
    paddingVertical: 3,
    borderRadius: 5,
    alignItems: 'center',
  },
  posText: {
    fontSize: 10,
    fontFamily: fonts.bold,
    letterSpacing: 0.3,
  },
  capBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capText: {
    fontSize: 10,
    fontFamily: fonts.bold,
  },
});
