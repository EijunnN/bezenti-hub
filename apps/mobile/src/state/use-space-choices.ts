import type { HomeListSpaceChoice } from "../features/home/home-list-filter-menu";
import { useLoadSpaces, useSpaceSelections } from "./spaces";
import { useSavedRemoteConnections } from "./use-remote-environment-registry";

/** The Space selector's choices: every connected Hub that lists Spaces for its signed-in User. */
export function useSpaceChoices(): ReadonlyArray<HomeListSpaceChoice> {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById);
  useLoadSpaces(connections);
  const selections = useSpaceSelections();
  return connections.flatMap((connection) => {
    const selection = selections.get(connection.environmentId);
    if (selection?.view == null || selection.view.spaces.length === 0) return [];
    return [
      {
        environmentId: connection.environmentId,
        environmentLabel: connection.environmentLabel,
        spaces: selection.view.spaces.map((space) => ({ id: space.id, name: space.name })),
        currentSpaceId: selection.currentSpaceId,
      },
    ];
  });
}
