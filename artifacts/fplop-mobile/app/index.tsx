import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  getListSolvesQueryKey,
  useDeleteSolve,
  useListSolves,
  type SolveRun,
} from '@workspace/api-client-react';
import { StatusPill } from '@/components/solve-ui';
import { fonts } from '@/constants/fonts';
import { useColors } from '@/hooks/useColors';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function gwRange(solve: SolveRun): string {
  const gws = solve.result?.gameweeks?.map((g) => g.gameweek) ?? [];
  if (gws.length > 0) {
    const lo = Math.min(...gws);
    const hi = Math.max(...gws);
    return lo === hi ? `GW ${lo}` : `GW ${lo}–${hi}`;
  }
  const horizon = solve.request.horizon ?? 5;
  return `${horizon} GW plan`;
}

function SolveCard({
  solve,
  onPress,
  onDelete,
}: {
  solve: SolveRun;
  onPress: () => void;
  onDelete: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={`solve-card-${solve.id}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.cardTop}>
        <StatusPill status={solve.status} />
        <Text style={[styles.cardDate, { color: colors.mutedForeground }]}>
          {formatDate(solve.createdAt)}
        </Text>
      </View>
      <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={1}>
        {gwRange(solve)}
      </Text>
      <Text
        style={[styles.cardSubtitle, { color: colors.mutedForeground }]}
        numberOfLines={1}
      >
        {solve.projectionFilename ?? 'Projection removed'}
      </Text>
      <View style={styles.cardBottom}>
        {solve.totalExpectedPoints != null ? (
          <Text style={[styles.points, { color: colors.tint }]}>
            {solve.totalExpectedPoints.toFixed(1)} xPts
          </Text>
        ) : solve.status === 'failed' ? (
          <Text
            style={[styles.errorText, { color: colors.destructive }]}
            numberOfLines={1}
          >
            {solve.error ?? 'Solve failed'}
          </Text>
        ) : (
          <View style={styles.runningRow}>
            <ActivityIndicator size="small" color={colors.tint} />
            <Text style={[styles.cardSubtitle, { color: colors.mutedForeground }]}>
              Optimizing…
            </Text>
          </View>
        )}
        <Pressable
          testID={`delete-solve-${solve.id}`}
          onPress={onDelete}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Feather name="trash-2" size={18} color={colors.mutedForeground} />
        </Pressable>
      </View>
    </Pressable>
  );
}

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const solvesQuery = useListSolves({
    query: {
      queryKey: getListSolvesQueryKey(),
      refetchInterval: (query) => {
        const data = query.state.data;
        const active = data?.some(
          (s) => s.status === 'queued' || s.status === 'running',
        );
        return active ? 4000 : false;
      },
    },
  });

  const deleteSolve = useDeleteSolve({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSolvesQueryKey() });
      },
    },
  });

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  const solves = solvesQuery.data ?? [];

  const confirmDelete = (solve: SolveRun) => {
    Alert.alert('Delete plan', 'Remove this solve from your history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          deleteSolve.mutate({ id: solve.id });
        },
      },
    ]);
  };

  const anyRunning = useMemo(
    () => solves.some((s) => s.status === 'queued' || s.status === 'running'),
    [solves],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 12 }]}>
        <View>
          <Text style={[styles.brand, { color: colors.foreground }]}>FPLOP</Text>
          <Text style={[styles.tagline, { color: colors.mutedForeground }]}>
            {anyRunning ? 'Solver running…' : 'Transfer plans'}
          </Text>
        </View>
        <View
          style={[
            styles.brandDot,
            { backgroundColor: colors.tint },
          ]}
        />
      </View>

      {solvesQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : solvesQuery.isError ? (
        <View style={styles.center}>
          <Feather name="wifi-off" size={32} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Can't reach the server
          </Text>
          <Pressable
            testID="retry-solves"
            onPress={() => solvesQuery.refetch()}
            style={({ pressed }) => [
              styles.retryButton,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={[styles.retryText, { color: colors.primaryForeground }]}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={solves}
          keyExtractor={(item) => item.id}
          scrollEnabled={solves.length > 0}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: bottomInset + 96 },
            solves.length === 0 && styles.listEmpty,
          ]}
          refreshControl={
            <RefreshControl
              refreshing={solvesQuery.isRefetching}
              onRefresh={() => solvesQuery.refetch()}
              tintColor={colors.tint}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="clipboard" size={32} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                No plans yet
              </Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                Start a solve to build your first multi-gameweek transfer plan.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <SolveCard
              solve={item}
              onPress={() => router.push(`/solve/${item.id}`)}
              onDelete={() => confirmDelete(item)}
            />
          )}
        />
      )}

      <Pressable
        testID="new-solve-button"
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.push('/new-solve');
        }}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: colors.primary,
            bottom: bottomInset + 24,
            transform: [{ scale: pressed ? 0.94 : 1 }],
          },
        ]}
      >
        <Feather name="plus" size={26} color={colors.primaryForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  brand: {
    fontSize: 28,
    fontFamily: fonts.extraBold,
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 13,
    fontFamily: fonts.medium,
    marginTop: 2,
  },
  brandDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginBottom: 10,
  },
  listContent: {
    paddingHorizontal: 16,
    gap: 12,
  },
  listEmpty: { flexGrow: 1 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 4,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardDate: {
    fontSize: 12,
    fontFamily: fonts.regular,
  },
  cardTitle: {
    fontSize: 18,
    fontFamily: fonts.bold,
  },
  cardSubtitle: {
    fontSize: 13,
    fontFamily: fonts.regular,
  },
  cardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  points: {
    fontSize: 16,
    fontFamily: fonts.monoBold,
  },
  errorText: {
    fontSize: 13,
    fontFamily: fonts.medium,
    flex: 1,
    marginRight: 12,
  },
  runningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 32,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: fonts.semiBold,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: fonts.regular,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 999,
    marginTop: 6,
  },
  retryText: {
    fontSize: 14,
    fontFamily: fonts.semiBold,
  },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
