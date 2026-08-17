import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  getGetSolveQueryKey,
  useGetSolve,
  useListFixtures,
  type FixtureInfo,
  type GameweekPlan,
  type PickPlayer,
} from '@workspace/api-client-react';
import {
  CaptainBadge,
  PositionBadge,
  StatusPill,
  chipLabel,
} from '@/components/solve-ui';
import { fonts } from '@/constants/fonts';
import { useColors } from '@/hooks/useColors';

type OpponentMap = Map<string, string[]>;

/** Build team -> ["MCI (H)", ...] for one gameweek, keyed by both short and full names. */
function buildOpponents(fixtures: FixtureInfo[] | undefined, gameweek: number): OpponentMap {
  const map: OpponentMap = new Map();
  if (!fixtures) return map;
  const add = (key: string, value: string) => {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  };
  for (const f of fixtures) {
    if (f.gameweek !== gameweek) continue;
    add(f.home, `${f.away} (H)`);
    add(f.homeName, `${f.away} (H)`);
    add(f.away, `${f.home} (A)`);
    add(f.awayName, `${f.home} (A)`);
  }
  return map;
}

function opponentText(map: OpponentMap, team: string): string {
  return map.get(team)?.join(', ') ?? '—';
}

const POSITION_ORDER = ['G', 'D', 'M', 'F'];

function PlayerRow({
  player,
  opponents,
  isTransferIn,
  chip,
  benchLabel,
}: {
  player: PickPlayer;
  opponents: OpponentMap;
  isTransferIn: boolean;
  chip?: string | null;
  benchLabel?: string;
}) {
  const colors = useColors();
  const multiplier = player.isCaptain ? (chip === 'triple_captain' ? 3 : 2) : 1;
  return (
    <View style={[rowStyles.row, { borderBottomColor: colors.border }]}>
      {benchLabel != null ? (
        <Text style={[rowStyles.benchOrder, { color: colors.mutedForeground }]}>
          {benchLabel}
        </Text>
      ) : (
        <PositionBadge position={player.position} />
      )}
      <View style={rowStyles.nameBlock}>
        <View style={rowStyles.nameRow}>
          <Text
            style={[rowStyles.name, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {player.name}
          </Text>
          {player.isCaptain ? <CaptainBadge /> : null}
          {player.isViceCaptain ? <CaptainBadge vice /> : null}
          {isTransferIn ? (
            <View style={[rowStyles.inBadge, { backgroundColor: colors.accent }]}>
              <Feather name="arrow-down-left" size={10} color={colors.accentForeground} />
            </View>
          ) : null}
        </View>
        <Text style={[rowStyles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
          {player.team} · {opponentText(opponents, player.team)} · £{player.price.toFixed(1)}
        </Text>
      </View>
      <Text style={[rowStyles.points, { color: colors.tint }]}>
        {(player.expectedPoints * multiplier).toFixed(1)}
      </Text>
    </View>
  );
}

function GameweekView({
  plan,
  fixtures,
}: {
  plan: GameweekPlan;
  fixtures: FixtureInfo[] | undefined;
}) {
  const colors = useColors();
  const opponents = useMemo(
    () => buildOpponents(fixtures, plan.gameweek),
    [fixtures, plan.gameweek],
  );

  const transferInSet = useMemo(() => new Set(plan.transfersIn), [plan.transfersIn]);
  const chip = chipLabel(plan.chip);

  const lineupByPosition = useMemo(() => {
    const groups = new Map<string, PickPlayer[]>();
    for (const pos of POSITION_ORDER) groups.set(pos, []);
    for (const p of plan.lineup) {
      const list = groups.get(p.position) ?? [];
      list.push(p);
      groups.set(p.position, list);
    }
    return POSITION_ORDER.flatMap((pos) => groups.get(pos) ?? []);
  }, [plan.lineup]);

  const bench = useMemo(
    () => [...plan.bench].sort((a, b) => (a.benchOrder ?? 0) - (b.benchOrder ?? 0)),
    [plan.bench],
  );

  return (
    <View style={gwStyles.container}>
      <View style={gwStyles.statsRow}>
        <View style={[gwStyles.stat, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[gwStyles.statLabel, { color: colors.mutedForeground }]}>Expected</Text>
          <Text style={[gwStyles.statValue, { color: colors.tint }]}>
            {plan.expectedPoints.toFixed(1)}
          </Text>
        </View>
        <View style={[gwStyles.stat, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[gwStyles.statLabel, { color: colors.mutedForeground }]}>Bank</Text>
          <Text style={[gwStyles.statValue, { color: colors.foreground }]}>
            {plan.bank != null ? `£${plan.bank.toFixed(1)}` : '—'}
          </Text>
        </View>
        {chip ? (
          <View style={[gwStyles.stat, { backgroundColor: colors.primary, borderColor: colors.primary }]}>
            <Text style={[gwStyles.statLabel, { color: colors.primaryForeground, opacity: 0.7 }]}>
              Chip
            </Text>
            <Text
              style={[gwStyles.statValueSmall, { color: colors.primaryForeground }]}
              numberOfLines={1}
            >
              {chip}
            </Text>
          </View>
        ) : null}
      </View>

      {plan.transfersIn.length > 0 || plan.transfersOut.length > 0 ? (
        <View style={[gwStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[gwStyles.sectionTitle, { color: colors.foreground }]}>Transfers</Text>
          {plan.transfersOut.map((name, i) => (
            <View key={`out-${name}`} style={gwStyles.transferRow}>
              <Feather name="arrow-up-right" size={14} color={colors.destructive} />
              <Text style={[gwStyles.transferName, { color: colors.mutedForeground }]}>
                {name}
              </Text>
              {plan.transfersIn[i] ? (
                <>
                  <Feather name="arrow-right" size={13} color={colors.mutedForeground} />
                  <Feather name="arrow-down-left" size={14} color={colors.tint} />
                  <Text style={[gwStyles.transferName, { color: colors.foreground }]}>
                    {plan.transfersIn[i]}
                  </Text>
                </>
              ) : null}
            </View>
          ))}
          {plan.transfersIn.slice(plan.transfersOut.length).map((name) => (
            <View key={`in-${name}`} style={gwStyles.transferRow}>
              <Feather name="arrow-down-left" size={14} color={colors.tint} />
              <Text style={[gwStyles.transferName, { color: colors.foreground }]}>{name}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={[gwStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[gwStyles.noTransfers, { color: colors.mutedForeground }]}>
            No transfers this gameweek
          </Text>
        </View>
      )}

      <View style={[gwStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[gwStyles.sectionTitle, { color: colors.foreground }]}>Starting XI</Text>
        {lineupByPosition.map((p) => (
          <PlayerRow
            key={p.name}
            player={p}
            opponents={opponents}
            isTransferIn={transferInSet.has(p.name)}
            chip={plan.chip}
          />
        ))}
      </View>

      <View style={[gwStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[gwStyles.sectionTitle, { color: colors.foreground }]}>Bench</Text>
        {bench.map((p) => (
          <PlayerRow
            key={p.name}
            player={p}
            opponents={opponents}
            isTransferIn={transferInSet.has(p.name)}
            benchLabel={p.benchOrder === 0 ? 'GK' : String(p.benchOrder ?? '')}
          />
        ))}
      </View>
    </View>
  );
}

export default function SolveDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [selectedGw, setSelectedGw] = useState<number | null>(null);

  const solveQuery = useGetSolve(id ?? '', {
    query: {
      queryKey: getGetSolveQueryKey(id ?? ''),
      enabled: !!id,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === 'queued' || status === 'running' ? 2000 : false;
      },
    },
  });
  const fixturesQuery = useListFixtures();

  const solve = solveQuery.data;
  const gameweeks = solve?.result?.gameweeks ?? [];

  useEffect(() => {
    if (selectedGw == null && gameweeks.length > 0) {
      setSelectedGw(gameweeks[0].gameweek);
    }
  }, [gameweeks, selectedGw]);

  const plan = gameweeks.find((g) => g.gameweek === selectedGw) ?? gameweeks[0];

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 8 }]}>
        <Pressable
          testID="back-button"
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [
            styles.backButton,
            { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {solve?.totalExpectedPoints != null
              ? `${solve.totalExpectedPoints.toFixed(1)} xPts total`
              : 'Transfer plan'}
          </Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]} numberOfLines={1}>
            {solve?.projectionFilename ?? ''}
          </Text>
        </View>
        {solve ? <StatusPill status={solve.status} /> : null}
      </View>

      {solveQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : solveQuery.isError || !solve ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
          <Text style={[styles.centerTitle, { color: colors.foreground }]}>
            Couldn't load this solve
          </Text>
          <Pressable
            testID="retry-solve"
            onPress={() => solveQuery.refetch()}
            style={({ pressed }) => [
              styles.retryButton,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={[styles.retryText, { color: colors.primaryForeground }]}>Retry</Text>
          </Pressable>
        </View>
      ) : solve.status === 'failed' ? (
        <View style={styles.center}>
          <Feather name="x-octagon" size={32} color={colors.destructive} />
          <Text style={[styles.centerTitle, { color: colors.foreground }]}>Solve failed</Text>
          <Text style={[styles.centerText, { color: colors.mutedForeground }]}>
            {solve.error ?? 'Unknown error'}
          </Text>
        </View>
      ) : solve.status !== 'completed' || !solve.result ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={[styles.centerTitle, { color: colors.foreground }]}>
            {solve.progress?.stage === 'solving' ? 'Optimizing squad' : 'Preparing solve'}
          </Text>
          <Text style={[styles.centerText, { color: colors.mutedForeground }]}>
            {solve.progress?.message ?? 'This can take a couple of minutes.'}
            {solve.progress?.gapPercent != null
              ? `\nGap ${solve.progress.gapPercent.toFixed(1)}%`
              : ''}
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.gwBar}
            contentContainerStyle={styles.gwBarContent}
          >
            {gameweeks.map((g) => {
              const active = g.gameweek === plan?.gameweek;
              return (
                <Pressable
                  key={g.gameweek}
                  testID={`gw-chip-${g.gameweek}`}
                  onPress={() => setSelectedGw(g.gameweek)}
                  style={({ pressed }) => [
                    styles.gwChip,
                    {
                      backgroundColor: active ? colors.primary : colors.card,
                      borderColor: active ? colors.primary : colors.border,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.gwChipText,
                      { color: active ? colors.primaryForeground : colors.foreground },
                    ]}
                  >
                    GW {g.gameweek}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <ScrollView
            contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
            showsVerticalScrollIndicator={false}
          >
            {plan ? <GameweekView plan={plan} fixtures={fixturesQuery.data} /> : null}
          </ScrollView>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1 },
  headerTitle: {
    fontSize: 18,
    fontFamily: fonts.bold,
  },
  headerSub: {
    fontSize: 12,
    fontFamily: fonts.regular,
    marginTop: 1,
  },
  gwBar: { flexGrow: 0 },
  gwBarContent: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  gwChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  gwChipText: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 32,
  },
  centerTitle: {
    fontSize: 17,
    fontFamily: fonts.semiBold,
  },
  centerText: {
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
});

const gwStyles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    gap: 12,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  stat: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 2,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: fonts.medium,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  statValue: {
    fontSize: 20,
    fontFamily: fonts.monoBold,
  },
  statValueSmall: {
    fontSize: 14,
    fontFamily: fonts.bold,
    marginTop: 3,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: fonts.bold,
    marginBottom: 8,
  },
  transferRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
  },
  transferName: {
    fontSize: 14,
    fontFamily: fonts.medium,
  },
  noTransfers: {
    fontSize: 14,
    fontFamily: fonts.regular,
  },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  benchOrder: {
    width: 38,
    textAlign: 'center',
    fontSize: 12,
    fontFamily: fonts.bold,
  },
  nameBlock: { flex: 1 },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  name: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
    flexShrink: 1,
  },
  inBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: {
    fontSize: 12,
    fontFamily: fonts.regular,
    marginTop: 1,
  },
  points: {
    fontSize: 15,
    fontFamily: fonts.monoBold,
  },
});
