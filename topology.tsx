import { Circle, Line, Svg, Text as SvgText } from "react-native-svg";
import { StyleSheet, View } from "react-native";
import type { LinkType, MeshRoute } from "@/lib/mesh/router";

export interface TopologyNode {
  id: string;
  direct: boolean;
  linkType?: LinkType;
  hops?: number;
  local?: boolean;
}

interface Props {
  localId: string;
  nodes: TopologyNode[];
  routes: Pick<MeshRoute, "destinationId" | "nextHopId" | "hops">[];
  width?: number;
  selectedId?: string | null;
  onNodePress?: (nodeId: string) => void;
}

const COLORS = {
  bg: "#101C27",
  direct: "#20C7B4",
  relay: "#E6AA5A",
  muted: "#3A4D5B",
  text: "#EAF1F4",
};

function shortId(id: string): string {
  if (id.length <= 9) return id;
  return `${id.slice(0, 4)}…${id.slice(-3)}`;
}

export function NetworkTopology({ localId, nodes, routes, width = 340, selectedId, onNodePress }: Props) {
  const height = 176;
  const unique = new Map<string, TopologyNode>();
  unique.set(localId, { id: localId, direct: true, local: true });
  for (const node of nodes) unique.set(node.id, node);
  const ordered = [...unique.values()];
  const centerX = width / 2;
  const centerY = 86;
  const remoteCount = Math.max(ordered.length - 1, 1);
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(localId, { x: centerX, y: centerY });
  ordered.filter((node) => !node.local).forEach((node, index) => {
    const angle = Math.PI + (Math.PI * (index + 1)) / (remoteCount + 1);
    const radiusX = Math.max(80, Math.min(width * 0.41, 145));
    positions.set(node.id, { x: centerX + Math.cos(angle) * radiusX, y: centerY + Math.sin(angle) * 55 });
  });

  const byId = new Map(ordered.map((node) => [node.id, node]));
  const directNodes = ordered.filter((node) => !node.local && node.direct);
  const relayedNodes = ordered.filter((node) => !node.local && !node.direct);
  const bestRoutes = new Map(routes.map((route) => [route.destinationId, route]));

  return (
    <View style={[styles.shell, { width, height }]}>
      <Svg width={width} height={height}>
        {directNodes.map((node) => {
          const point = positions.get(node.id)!;
          return <Line key={`d-${node.id}`} x1={centerX} y1={centerY} x2={point.x} y2={point.y} stroke={COLORS.direct} strokeWidth={2} />;
        })}
        {relayedNodes.map((node) => {
          const point = positions.get(node.id)!;
          const route = bestRoutes.get(node.id);
          const hopNode = route ? byId.get(route.nextHopId) : undefined;
          const hopPoint = hopNode ? positions.get(hopNode.id) : undefined;
          if (hopPoint) {
            return <Line key={`r-${node.id}`} x1={hopPoint.x} y1={hopPoint.y} x2={point.x} y2={point.y} stroke={COLORS.relay} strokeWidth={2} strokeDasharray="5 5" />;
          }
          return <Line key={`r-${node.id}`} x1={centerX} y1={centerY} x2={point.x} y2={point.y} stroke={COLORS.relay} strokeWidth={2} strokeDasharray="5 5" />;
        })}
        {ordered.map((node) => {
          const point = positions.get(node.id)!;
          const fill = node.local ? COLORS.text : node.direct ? COLORS.direct : COLORS.relay;
          return (
            <Svg key={`n-${node.id}`}>
              <Circle
                cx={point.x}
                cy={point.y}
                r={node.local ? 17 : 13}
                fill={fill}
                stroke={selectedId === node.id ? COLORS.text : "transparent"}
                strokeWidth={selectedId === node.id ? 3 : 0}
                onPress={() => !node.local && onNodePress?.(node.id)}
              />
              <SvgText x={point.x} y={point.y + 31} fill={COLORS.text} fontSize={10} textAnchor="middle">
                {shortId(node.id)}{node.hops ? ` · ${node.hops} قفزات` : node.local ? " · هذا الجهاز" : ""}
              </SvgText>
            </Svg>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { alignSelf: "center", backgroundColor: COLORS.bg, borderRadius: 18, overflow: "hidden" },
});
