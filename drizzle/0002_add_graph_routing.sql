-- node_routing_v2: DAG 분기 라우팅 지원
-- node_instances에 graph_node_id, edges 추가
ALTER TABLE node_instances
  ADD COLUMN graph_node_id TEXT,
  ADD COLUMN edges JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS node_instances_run_graph_idx
  ON node_instances(run_id, graph_node_id);

-- run_sessions에 current_graph_node_id, route_tag 추가
ALTER TABLE run_sessions
  ADD COLUMN current_graph_node_id TEXT,
  ADD COLUMN route_tag TEXT;
