import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import {
  getListSolvesQueryKey,
  useCreateSolve,
  useGetGameweekInfo,
  useListProjections,
} from '@workspace/api-client-react';
import { fonts } from '@/constants/fonts';
import { useColors } from '@/hooks/useColors';

export default function NewSolveScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const projectionsQuery = useListProjections();
  const gameweekQuery = useGetGameweekInfo();

  const [projectionId, setProjectionId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string>('');
  const [horizon, setHorizon] = useState<number>(5);
  const [formError, setFormError] = useState<string | null>(null);

  const isFirstGameweek = gameweekQuery.data?.isFirstGameweek ?? false;

  const createSolve = useCreateSolve({
    mutation: {
      onSuccess: (solve) => {
        queryClient.invalidateQueries({ queryKey: getListSolvesQueryKey() });
        router.replace(`/solve/${solve.id}`);
      },
      onError: (err) => {
        setFormError(err instanceof Error ? err.message : 'Failed to start solve');
      },
    },
  });

  const projections = projectionsQuery.data ?? [];
  const selectedProjection = useMemo(
    () => projections.find((p) => p.id === projectionId) ?? null,
    [projections, projectionId],
  );

  const canSubmit =
    !!projectionId &&
    (isFirstGameweek || teamId.trim().length > 0) &&
    !createSolve.isPending;

  const submit = () => {
    setFormError(null);
    if (!projectionId) {
      setFormError('Select a projection file first.');
      return;
    }
    const parsedTeamId = Number(teamId.trim());
    if (!isFirstGameweek && (!teamId.trim() || Number.isNaN(parsedTeamId))) {
      setFormError('Enter your FPL team ID (a number).');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    createSolve.mutate({
      data: {
        projectionId,
        firstGameweek: isFirstGameweek,
        teamId: isFirstGameweek ? null : parsedTeamId,
        horizon,
      },
    });
  };

  const topInset = Platform.OS === 'web' ? 67 : Math.max(insets.top, 12);
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>New solve</Text>
        <Pressable
          testID="close-new-solve"
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Feather name="x" size={24} color={colors.foreground} />
        </Pressable>
      </View>

      <KeyboardAwareScrollViewCompat
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]}
      >
        <Text style={[styles.label, { color: colors.mutedForeground }]}>PROJECTION</Text>
        {projectionsQuery.isLoading ? (
          <ActivityIndicator color={colors.tint} />
        ) : projections.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="upload" size={20} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              No projection files. Upload or import one from the web app first.
            </Text>
          </View>
        ) : (
          projections.map((p) => {
            const active = p.id === projectionId;
            return (
              <Pressable
                key={p.id}
                testID={`projection-${p.id}`}
                onPress={() => {
                  Haptics.selectionAsync();
                  setProjectionId(p.id);
                }}
                style={({ pressed }) => [
                  styles.option,
                  {
                    backgroundColor: colors.card,
                    borderColor: active ? colors.primary : colors.border,
                    borderWidth: active ? 2 : 1,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <View style={styles.optionText}>
                  <Text style={[styles.optionTitle, { color: colors.foreground }]} numberOfLines={1}>
                    {p.filename}
                  </Text>
                  <Text style={[styles.optionMeta, { color: colors.mutedForeground }]}>
                    {p.playerCount} players · GW {Math.min(...p.gameweeks)}–{Math.max(...p.gameweeks)}
                  </Text>
                </View>
                {active ? <Feather name="check-circle" size={20} color={colors.primary} /> : null}
              </Pressable>
            );
          })
        )}

        {!isFirstGameweek ? (
          <>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>FPL TEAM ID</Text>
            <TextInput
              testID="team-id-input"
              value={teamId}
              onChangeText={setTeamId}
              placeholder="e.g. 1234567"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.input,
                  color: colors.foreground,
                },
              ]}
            />
          </>
        ) : null}

        <Text style={[styles.label, { color: colors.mutedForeground }]}>
          HORIZON — {horizon} GAMEWEEK{horizon === 1 ? '' : 'S'}
        </Text>
        <View style={styles.stepperRow}>
          {[3, 4, 5, 6, 8].map((h) => {
            const active = h === horizon;
            return (
              <Pressable
                key={h}
                testID={`horizon-${h}`}
                onPress={() => {
                  Haptics.selectionAsync();
                  setHorizon(h);
                }}
                style={({ pressed }) => [
                  styles.stepperChip,
                  {
                    backgroundColor: active ? colors.primary : colors.card,
                    borderColor: active ? colors.primary : colors.border,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.stepperText,
                    { color: active ? colors.primaryForeground : colors.foreground },
                  ]}
                >
                  {h}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {gameweekQuery.data ? (
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Planning from GW {gameweekQuery.data.nextGameweek}
            {isFirstGameweek ? ' — full squad built from scratch.' : '.'}
          </Text>
        ) : null}

        {formError ? (
          <Text style={[styles.error, { color: colors.destructive }]}>{formError}</Text>
        ) : null}

        <Pressable
          testID="start-solve-button"
          disabled={!canSubmit}
          onPress={submit}
          style={({ pressed }) => [
            styles.submit,
            {
              backgroundColor: colors.primary,
              opacity: !canSubmit ? 0.4 : pressed ? 0.85 : 1,
            },
          ]}
        >
          {createSolve.isPending ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <>
              <Feather name="play" size={16} color={colors.primaryForeground} />
              <Text style={[styles.submitText, { color: colors.primaryForeground }]}>
                Start solve
              </Text>
            </>
          )}
        </Pressable>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  title: {
    fontSize: 22,
    fontFamily: fonts.bold,
  },
  content: {
    paddingHorizontal: 20,
    gap: 10,
  },
  label: {
    fontSize: 11,
    fontFamily: fonts.bold,
    letterSpacing: 0.8,
    marginTop: 14,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 12,
    padding: 14,
  },
  optionText: { flex: 1 },
  optionTitle: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
  },
  optionMeta: {
    fontSize: 12,
    fontFamily: fonts.regular,
    marginTop: 2,
  },
  emptyCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    fontFamily: fonts.regular,
    textAlign: 'center',
    lineHeight: 18,
  },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: fonts.medium,
  },
  stepperRow: {
    flexDirection: 'row',
    gap: 8,
  },
  stepperChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  stepperText: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
  },
  hint: {
    fontSize: 13,
    fontFamily: fonts.regular,
    marginTop: 4,
  },
  error: {
    fontSize: 13,
    fontFamily: fonts.medium,
  },
  submit: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 15,
    marginTop: 16,
  },
  submitText: {
    fontSize: 16,
    fontFamily: fonts.bold,
  },
});
