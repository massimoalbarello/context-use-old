import type { DashboardObjectSummary } from "@context-use/shared";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AssetDetails } from "../../../../components/Assets.tsx";
import { Editor } from "../../../../components/Editor.tsx";
import { ObjectDetails } from "../../../../components/ObjectDetails.tsx";
import { SourceRecord } from "../../../../components/SourceRecord.tsx";
import { useDashboardWorkspace } from "../../../../lib/workspace/dashboard-workspace.tsx";
import { assetsQueryOptions } from "../../../../queries/assets.ts";
import { objectQueryOptions } from "../../../../queries/objects.ts";
import { appRoute } from "../../route.tsx";

function ObjectRoute() {
  const { objectId } = objectRoute.useParams();
  const navigate = objectRoute.useNavigate();
  const workspace = useDashboardWorkspace();
  const objectQuery = useQuery(objectQueryOptions(objectId));
  const object = objectQuery.data ?? null;
  const assetsQuery = useQuery({
    ...assetsQueryOptions(),
    enabled: object?.object_kind === "asset",
  });
  const asset = assetsQuery.data?.find((candidate) => candidate.id === objectId) ?? null;

  useEffect(() => {
    if (!objectQuery.error) {
      return;
    }
    workspace.showMessage(
      objectQuery.error instanceof Error ? objectQuery.error.message : "Could not open object",
    );
  }, [objectQuery.error, workspace]);

  const returnHome = async () => {
    await navigate({ to: "/app" });
    workspace.refreshNavigator();
  };

  if (object?.object_kind === "page") {
    return (
      <Editor
        pageId={objectId}
        onChanged={async () => workspace.refreshNavigator()}
        onDeleted={async () => {
          await returnHome();
          workspace.showMessage(
            "Page and retained revisions deleted. A body-free tombstone remains in Change history.",
          );
        }}
        onOpenObject={(nextObject) => workspace.openObject({ object: nextObject })}
      />
    );
  }
  if (object?.object_kind === "record") {
    return (
      <SourceRecord
        objectId={objectId}
        onChanged={async () => workspace.refreshNavigator()}
        onDeleted={async () => {
          await returnHome();
          workspace.showMessage(
            "Source record and retained revisions deleted from the live database.",
          );
        }}
      />
    );
  }
  if (asset) {
    return (
      <AssetDetails
        key={asset.id}
        asset={asset}
        onChanged={async () => {
          await assetsQuery.refetch();
          workspace.refreshNavigator();
        }}
        onDeleted={async () => {
          await returnHome();
          await assetsQuery.refetch();
          workspace.showMessage(
            "Asset deleted. S3 versioning retains a recoverable noncurrent copy for the configured safety period.",
          );
        }}
      />
    );
  }
  if (object) {
    return <ObjectDetails object={object as DashboardObjectSummary} />;
  }
  return <main className="editor-empty">Loading object…</main>;
}

export const objectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "objects/$objectId",
  component: ObjectRoute,
});
