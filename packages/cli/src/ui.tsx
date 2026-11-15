import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { formatDuration, formatTokens, formatUsd, progressBar, type FileRow, type ProgressState, type Store } from "./progress.ts";

const VISIBLE_FILES = 12;

function statusColor(status: FileRow["status"]): string {
  switch (status) {
    case "parsed":
    case "uploaded":
    case "scored":
      return "green";
    case "duplicate":
    case "rejected":
      return "yellow";
    default:
      return "red";
  }
}

function useStore(store: Store): ProgressState {
  const [state, setState] = useState(store.getState());
  useEffect(() => {
    setState(store.getState());
    return store.subscribe(() => setState(store.getState()));
  }, [store]);
  return state;
}

export function App({ store, title }: { store: Store; title: string }) {
  const s = useStore(store);
  const shown = s.files.slice(-VISIBLE_FILES);
  const counts = Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join("  ");
  return (
    <Box flexDirection="column">
      <Text bold>
        Resume Intake <Text dimColor>{title}</Text>
      </Text>
      <Text>
        {s.phase}
        {s.detail ? <Text dimColor> - {s.detail}</Text> : null}
      </Text>
      <Text>
        {progressBar(s.done, s.total)} {s.done}/{s.total} files  <Text dimColor>elapsed {formatDuration(s.elapsed)}  eta {formatDuration(s.eta)}</Text>
      </Text>
      <Text>
        tokens {formatTokens(s.tokens)}  cost {formatUsd(s.usd)}
      </Text>
      {counts ? <Text dimColor>{counts}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {shown.map((f) => (
          <Text key={f.name}>
            <Text color={statusColor(f.status)}>{f.status.padEnd(13)}</Text> {f.name}
            {f.detail ? <Text dimColor>  {f.detail}</Text> : null}
          </Text>
        ))}
      </Box>
      {s.failures.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>
            Failures ({s.failures.length})
          </Text>
          {s.failures.slice(-6).map((f) => (
            <Text key={f.name} color="red">
              {f.name}: {f.reason || f.status}
            </Text>
          ))}
        </Box>
      ) : null}
      {s.commit ? (
        <Box marginTop={1}>
          <Text>
            Sink {s.commit.dryRun ? "(dry run) " : ""}
            {s.commit.status}  ready {s.commit.ready}  duplicate {s.commit.duplicate}  conflict {s.commit.conflict}  invalid {s.commit.invalid}  created {s.commit.created}
            {s.commit.error ? <Text color="red">  {s.commit.error}</Text> : null}
          </Text>
        </Box>
      ) : null}
      {s.logs.length ? (
        <Box flexDirection="column" marginTop={1}>
          {s.logs.slice(-4).map((l, i) => (
            <Text key={`${i}-${l}`} dimColor>
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
