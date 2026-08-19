import { collectFacts, type Fact } from './facts.ts';

/** A directory worth naming under the headline, such as the preview root. */
interface CommandOutputLocation {
  label: string;
  path: string;
}

/**
 * One command's finished result. Detail lines are the array itself; framing rides
 * alongside as data, because the CLI and `--json` lay the same result out
 * differently and neither should parse the other's text.
 */
export type CommandOutputLines = string[] & {
  summary?: Fact[] | undefined;
  detailHeading?: string | undefined;
  locations?: CommandOutputLocation[] | undefined;
  nextSteps?: string[] | undefined;
};

interface CommandOutputDescription {
  /** The headline numbers. Facts with nothing to say are dropped. */
  summary: ReadonlyArray<Fact | undefined>;
  /** What the detail lines are, as a plural noun: `preview files`, `checks`. */
  detailHeading: string;
  locations?: CommandOutputLocation[] | undefined;
  nextSteps?: string[] | undefined;
}

/** The single way a command hands its result back. */
export function toCommandOutput(
  lines: string[],
  description: CommandOutputDescription,
): CommandOutputLines {
  return Object.assign(lines, {
    summary: collectFacts(description.summary),
    detailHeading: description.detailHeading,
    locations: description.locations,
    nextSteps: description.nextSteps,
  });
}
