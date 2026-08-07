import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { startTransition, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client";
import type {
  AppSettings,
  AuthProfile,
  ConflictStrategy,
  CreateAuthProfileInput,
  CreateRulesetInput,
  DaemonEvent,
  DownloadDetails,
  DownloadView,
  Ruleset,
  RulesetAction,
  RulesetMatcher,
} from "../domain/types";
import { createDownloadInputsFromBatch } from "../intake/parser";
import { formatDuration } from "../lib/time";
import { formatBytes, formatSpeed } from "../lib/units";

const TABS = ["Queue", "History", "Rules", "Auth", "Settings", "Activity"] as const;
const TAB_KEYS = ["1", "2", "3", "4", "5", "6"] as const;
type TabName = (typeof TABS)[number];
type PaneFocus = "list" | "detail";
type FieldFocus =
  | "one"
  | "two"
  | "three"
  | "four"
  | "five"
  | "six"
  | "seven"
  | "eight";

type ModalState =
  | { type: "add" }
  | { type: "import" }
  | { type: "filter" }
  | { type: "ruleset"; mode: "create" | "edit"; rulesetId?: string }
  | { type: "auth"; mode: "create" | "edit"; profileId?: string }
  | { type: "settings" }
  | { type: "confirm-quit" }
  | null;

type HeaderFormState = {
  name: string;
  lines: string;
};

type AddFormState = {
  source: string;
  destinationDir: string;
  filename: string;
  authProfileId: string;
  rulesetId: string;
  conflictStrategy: ConflictStrategy;
};

type ImportFormState = {
  source: string;
  queueAfterParse: boolean;
  destinationDir: string;
};

type RulesetFormState = {
  name: string;
  host: string;
  destinationDir: string;
  scheduleWindow: string;
  maxSegments: string;
  authProfileId: string;
};

type SettingsFormState = {
  defaultDownloadDir: string;
  globalConcurrency: string;
  perHostConcurrency: string;
  quietHours: string;
  clipboardWatcherEnabled: boolean;
  notifyOnComplete: boolean;
};

const COLORS = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  surfaceAlt: "#222222",
  border: "#303030",
  text: "#f0f0f0",
  muted: "#a0a0a0",
  dim: "#707070",
  accent: "#00d4aa",
  warn: "#ffb84d",
  danger: "#ff7a7a",
};

export async function launchTui(client: ApiClient): Promise<void> {
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    useMouse: false,
    exitOnCtrlC: true,
  });

  createRoot(renderer).render(<TuiApp client={client} />);
}

function TuiApp({ client }: { client: ApiClient }) {
  const renderer = useRenderer();
  const [tabIndex, setTabIndex] = useState(0);
  const [paneFocus, setPaneFocus] = useState<PaneFocus>("list");
  const [modal, setModal] = useState<ModalState>(null);
  const [fieldFocus, setFieldFocus] = useState<FieldFocus>("one");
  const [showHelp, setShowHelp] = useState(false);
  const [statusLine, setStatusLine] = useState("Connecting to daemon…");
  const [filter, setFilter] = useState("");
  const [filterDraft, setFilterDraft] = useState("");
  const [downloads, setDownloads] = useState<DownloadView[]>([]);
  const [history, setHistory] = useState<DownloadView[]>([]);
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<{
    ok: boolean;
    active: number;
    history: number;
    queue: number;
    clipboardWatcherEnabled: boolean;
  } | null>(null);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const [downloadDetails, setDownloadDetails] = useState<DownloadDetails | null>(null);
  const [selectedByTab, setSelectedByTab] = useState<Record<TabName, number>>({
    Queue: 0,
    History: 0,
    Rules: 0,
    Auth: 0,
    Settings: 0,
    Activity: 0,
  });
  const [addForm, setAddForm] = useState<AddFormState>(createDefaultAddForm(""));
  const [importForm, setImportForm] = useState<ImportFormState>({
    source: "",
    queueAfterParse: false,
    destinationDir: "",
  });
  const [rulesetForm, setRulesetForm] = useState<RulesetFormState>(createDefaultRulesetForm(""));
  const [authForm, setAuthForm] = useState<HeaderFormState>({
    name: "",
    lines: "",
  });
  const [settingsForm, setSettingsForm] = useState<SettingsFormState>({
    defaultDownloadDir: "",
    globalConcurrency: "3",
    perHostConcurrency: "2",
    quietHours: "",
    clipboardWatcherEnabled: false,
    notifyOnComplete: true,
  });

  const activeTab = TABS[tabIndex]!;
  const activeSelection = selectedByTab[activeTab];
  const filteredDownloads = useMemo(
    () => filterDownloads(downloads, filter),
    [downloads, filter],
  );
  const filteredHistory = useMemo(
    () => filterDownloads(history, filter),
    [history, filter],
  );
  const filteredRulesets = useMemo(
    () => rulesets.filter((item) => includesFilter([item.name, item.id], filter)),
    [rulesets, filter],
  );
  const filteredAuthProfiles = useMemo(
    () => authProfiles.filter((item) => includesFilter([item.name, item.id], filter)),
    [authProfiles, filter],
  );
  const filteredEvents = useMemo(
    () =>
      events.filter((event) =>
        includesFilter([event.type, event.downloadId ?? "", JSON.stringify(event.payload)], filter),
      ),
    [events, filter],
  );

  const currentListLength =
    activeTab === "Queue"
      ? filteredDownloads.length
      : activeTab === "History"
        ? filteredHistory.length
        : activeTab === "Rules"
          ? filteredRulesets.length
          : activeTab === "Auth"
            ? filteredAuthProfiles.length
            : activeTab === "Activity"
              ? filteredEvents.length
              : 1;

  const selectedDownload = activeTab === "Queue" ? filteredDownloads[Math.min(activeSelection, Math.max(0, filteredDownloads.length - 1))] ?? null : null;
  const selectedHistory = activeTab === "History" ? filteredHistory[Math.min(activeSelection, Math.max(0, filteredHistory.length - 1))] ?? null : null;
  const selectedRuleset = activeTab === "Rules" ? filteredRulesets[Math.min(activeSelection, Math.max(0, filteredRulesets.length - 1))] ?? null : null;
  const selectedProfile = activeTab === "Auth" ? filteredAuthProfiles[Math.min(activeSelection, Math.max(0, filteredAuthProfiles.length - 1))] ?? null : null;
  const selectedEvent = activeTab === "Activity" ? filteredEvents[Math.min(activeSelection, Math.max(0, filteredEvents.length - 1))] ?? null : null;
  const selectedDownloadId = selectedDownload?.id ?? selectedHistory?.id ?? null;

  useEffect(() => {
    void refreshAll(true);
    const poll = setInterval(() => {
      void refreshAll(false);
    }, 2000);

    let cancelled = false;
    void (async () => {
      try {
        for await (const event of client.events()) {
          if (cancelled) {
            return;
          }
          startTransition(() => {
            setEvents((current) => [...current.slice(-199), event]);
          });
          if (event.type !== "clipboard.candidate") {
            void refreshAll(false);
          }
        }
      } catch (error) {
        setStatusLine(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    if (!selectedDownloadId || (activeTab !== "Queue" && activeTab !== "History")) {
      setDownloadDetails(null);
      return;
    }
    let cancelled = false;
    void client
      .getDownload(selectedDownloadId)
      .then((details) => {
        if (!cancelled) {
          setDownloadDetails(details);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatusLine(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDownloadId, activeTab]);

  useKeyboard((event) => {
    if (modal?.type === "confirm-quit") {
      if (event.name === "y") {
        void client.pauseDownload("all").finally(() => renderer.destroy());
      }
      if (event.name === "n" || event.name === "escape") {
        setModal(null);
      }
      return;
    }

    if (modal) {
      handleModalKey(event.name);
      return;
    }

    switch (event.name) {
      case "q":
        if (downloads.some((item) => item.status === "downloading")) {
          setModal({ type: "confirm-quit" });
        } else {
          renderer.destroy();
        }
        return;
      case "?":
        setShowHelp((current) => !current);
        return;
      case "left":
      case "[":
        shiftTab(-1);
        return;
      case "right":
      case "]":
        shiftTab(1);
        return;
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
        selectTabByKey(event.name);
        return;
      case "tab":
        setPaneFocus((current) => (current === "list" ? "detail" : "list"));
        return;
      case "/":
        setFilterDraft(filter);
        setFieldFocus("one");
        setModal({ type: "filter" });
        return;
      case "up":
        moveSelection(-1);
        return;
      case "down":
        moveSelection(1);
        return;
      case "a":
        openCreateModal();
        return;
      case "i":
        setImportForm({
          source: "",
          queueAfterParse: false,
          destinationDir: settings?.defaultDownloadDir ?? "",
        });
        setFieldFocus("one");
        setModal({ type: "import" });
        return;
      case "e":
        void openEditModal();
        return;
      case "d":
        void deleteSelection();
        return;
      case "p":
        void togglePauseSelected();
        return;
      case "x":
        void cancelSelected();
        return;
      case "r":
        void retrySelected();
        return;
      default:
        return;
    }
  });

  function moveSelection(delta: number) {
    if (paneFocus !== "list") {
      return;
    }
    setSelectedByTab((current) => ({
      ...current,
      [activeTab]: clamp(current[activeTab] + delta, 0, Math.max(0, currentListLength - 1)),
    }));
  }

  function shiftTab(delta: number) {
    setPaneFocus("list");
    setTabIndex((current) => (current + delta + TABS.length) % TABS.length);
  }

  function selectTabByKey(keyName: string) {
    const index = TAB_KEYS.indexOf(keyName as (typeof TAB_KEYS)[number]);
    if (index === -1) {
      return;
    }
    setPaneFocus("list");
    setTabIndex(index);
  }

  async function refreshAll(updateStatus = false) {
    try {
      const [nextDownloads, nextHistory, nextRulesets, nextAuthProfiles, nextSettings, nextDaemonStatus] =
        await Promise.all([
          client.listDownloads(true),
          client.listHistory(),
          client.listRulesets(),
          client.listAuthProfiles(),
          client.getSettings(),
          client.daemonStatus(),
        ]);
      startTransition(() => {
        setDownloads(nextDownloads);
        setHistory(nextHistory);
        setRulesets(nextRulesets);
        setAuthProfiles(nextAuthProfiles);
        setSettings(nextSettings);
        setDaemonStatus(nextDaemonStatus);
        if (updateStatus) {
          setStatusLine(
            `Daemon ready. ${nextDaemonStatus.active} active, ${nextDaemonStatus.queue} queued, ${nextDaemonStatus.history} history.`,
          );
        }
      });
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : String(error));
    }
  }

  function openCreateModal() {
    if (activeTab === "Rules") {
      setRulesetForm(createDefaultRulesetForm(settings?.defaultDownloadDir ?? ""));
      setFieldFocus("one");
      setModal({ type: "ruleset", mode: "create" });
      return;
    }
    if (activeTab === "Auth") {
      setAuthForm({ name: "", lines: "" });
      setFieldFocus("one");
      setModal({ type: "auth", mode: "create" });
      return;
    }
    if (activeTab === "Settings") {
      openSettingsModal();
      return;
    }

    setAddForm(createDefaultAddForm(settings?.defaultDownloadDir ?? ""));
    setFieldFocus("one");
    setModal({ type: "add" });
  }

  async function openEditModal() {
    if (activeTab === "Rules" && selectedRuleset) {
      setRulesetForm(extractRulesetForm(selectedRuleset));
      setFieldFocus("one");
      setModal({ type: "ruleset", mode: "edit", rulesetId: selectedRuleset.id });
      return;
    }
    if (activeTab === "Auth" && selectedProfile) {
      setAuthForm({
        name: selectedProfile.name,
        lines: serializeHeaders(selectedProfile.headers),
      });
      setFieldFocus("one");
      setModal({ type: "auth", mode: "edit", profileId: selectedProfile.id });
      return;
    }
    if (activeTab === "Settings") {
      openSettingsModal();
      return;
    }
    if ((activeTab === "Queue" || activeTab === "History") && selectedDownloadId) {
      const target = selectedDownload ?? selectedHistory;
      if (target) {
        await client.retryDownload(target.id);
        setStatusLine(`Requested retry for ${target.fileName}.`);
        await refreshAll(false);
      }
    }
  }

  function openSettingsModal() {
    setSettingsForm({
      defaultDownloadDir: settings?.defaultDownloadDir ?? "",
      globalConcurrency: String(settings?.globalConcurrency ?? 3),
      perHostConcurrency: String(settings?.perHostConcurrency ?? 2),
      quietHours: settings?.quietHours ?? "",
      clipboardWatcherEnabled: settings?.clipboardWatcherEnabled ?? false,
      notifyOnComplete: settings?.notifyOnComplete ?? true,
    });
    setFieldFocus("one");
    setModal({ type: "settings" });
  }

  async function deleteSelection() {
    try {
      if (activeTab === "Rules" && selectedRuleset) {
        await client.deleteRuleset(selectedRuleset.id);
        setStatusLine(`Removed ruleset ${selectedRuleset.name}.`);
      } else if (activeTab === "Auth" && selectedProfile) {
        await client.deleteAuthProfile(selectedProfile.id);
        setStatusLine(`Removed auth profile ${selectedProfile.name}.`);
      } else if ((activeTab === "Queue" || activeTab === "History") && selectedDownloadId) {
        const target = selectedDownload ?? selectedHistory;
        if (target) {
          await client.removeDownload(target.id, false);
          setStatusLine(`Removed ${target.fileName}.`);
        }
      }
      await refreshAll(false);
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : String(error));
    }
  }

  async function togglePauseSelected() {
    const target = selectedDownload ?? selectedHistory;
    if (!target) {
      return;
    }
    try {
      if (target.status === "paused" || target.status === "restart_required") {
        await client.resumeDownload(target.id);
      } else {
        await client.pauseDownload(target.id);
      }
      await refreshAll(false);
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelSelected() {
    const target = selectedDownload ?? selectedHistory;
    if (!target) {
      return;
    }
    try {
      await client.cancelDownload(target.id);
      setStatusLine(`Canceled ${target.fileName}.`);
      await refreshAll(false);
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : String(error));
    }
  }

  async function retrySelected() {
    const target = selectedDownload ?? selectedHistory;
    if (!target) {
      return;
    }
    try {
      await client.retryDownload(target.id);
      setStatusLine(`Retry requested for ${target.fileName}.`);
      await refreshAll(false);
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : String(error));
    }
  }

  function handleModalKey(keyName: string) {
    if (!modal) {
      return;
    }
    if (keyName === "escape") {
      setModal(null);
      return;
    }
    if (keyName === "tab") {
      cycleFieldFocus();
      return;
    }
    if (keyName === "left" || keyName === "right") {
      const direction = keyName === "right" ? 1 : -1;
      if (modal.type === "add") {
        if (fieldFocus === "four") {
          setAddForm((current) => ({
            ...current,
            authProfileId: cycleById(authProfiles, current.authProfileId, direction),
          }));
        } else if (fieldFocus === "five") {
          setAddForm((current) => ({
            ...current,
            rulesetId: cycleById(rulesets, current.rulesetId, direction),
          }));
        } else if (fieldFocus === "six") {
          setAddForm((current) => ({
            ...current,
            conflictStrategy: cycleConflictStrategy(current.conflictStrategy, direction),
          }));
        }
      } else if (modal.type === "import" && fieldFocus === "two") {
        setImportForm((current) => ({
          ...current,
          queueAfterParse: !current.queueAfterParse,
        }));
      } else if (modal.type === "ruleset" && fieldFocus === "six") {
        setRulesetForm((current) => ({
          ...current,
          authProfileId: cycleById(authProfiles, current.authProfileId, direction),
        }));
      } else if (modal.type === "settings") {
        if (fieldFocus === "five") {
          setSettingsForm((current) => ({
            ...current,
            clipboardWatcherEnabled: !current.clipboardWatcherEnabled,
          }));
        } else if (fieldFocus === "six") {
          setSettingsForm((current) => ({
            ...current,
            notifyOnComplete: !current.notifyOnComplete,
          }));
        }
      }
    }
  }

  function cycleFieldFocus() {
    setFieldFocus((current) =>
      current === "one"
        ? "two"
        : current === "two"
          ? "three"
          : current === "three"
            ? "four"
            : current === "four"
              ? "five"
              : current === "five"
                ? "six"
                : current === "six"
                  ? "seven"
                  : current === "seven"
                    ? "eight"
                    : "one",
    );
  }

  async function submitModal() {
    try {
      if (!modal) {
        return;
      }

      if (modal.type === "add") {
        const parsed = await client.parseIntakeBatch(addForm.source);
        if (parsed.kind === "har") {
          await client.bulkAdd(
            createDownloadInputsFromBatch(parsed, {
              destinationDir: addForm.destinationDir || undefined,
              filename: addForm.filename || undefined,
              authProfileId: addForm.authProfileId || undefined,
              rulesetId: addForm.rulesetId || null,
              conflictStrategy: addForm.conflictStrategy,
            }),
          );
          setStatusLine(`Queued ${parsed.items.length} download${parsed.items.length === 1 ? "" : "s"} from HAR.`);
        } else {
          await client.addDownload({
            source: addForm.source,
            destinationDir: addForm.destinationDir || undefined,
            filename: addForm.filename || undefined,
            authProfileId: addForm.authProfileId || undefined,
            rulesetId: addForm.rulesetId || null,
            conflictStrategy: addForm.conflictStrategy,
          });
          setStatusLine("Download queued.");
        }
      } else if (modal.type === "import") {
        const parsed = await client.parseIntakeBatch(importForm.source);
        if (importForm.queueAfterParse) {
          if (parsed.kind === "har") {
            await client.bulkAdd(
              createDownloadInputsFromBatch(parsed, {
                destinationDir: importForm.destinationDir || undefined,
              }),
            );
            setStatusLine(`Imported and queued ${parsed.items.length} HAR request${parsed.items.length === 1 ? "" : "s"}.`);
          } else {
            await client.addDownload({
              source: importForm.source,
              intakeKind: parsed.kind,
              destinationDir: importForm.destinationDir || undefined,
            });
            setStatusLine(`Imported and queued ${parsed.items[0]?.url ?? "request"}.`);
          }
        } else {
          setStatusLine(
            parsed.kind === "har"
              ? `Parsed HAR with ${parsed.items.length} importable request${parsed.items.length === 1 ? "" : "s"}.`
              : `Parsed ${parsed.kind}: ${parsed.items[0]?.url ?? "request"}`,
          );
        }
      } else if (modal.type === "filter") {
        setFilter(filterDraft);
        setStatusLine(filterDraft ? `Filter set to "${filterDraft}".` : "Filter cleared.");
      } else if (modal.type === "ruleset") {
        const payload = buildRulesetPayload(modal.mode === "edit" ? selectedRuleset : null, rulesetForm);
        if (modal.mode === "edit" && modal.rulesetId) {
          await client.updateRuleset(modal.rulesetId, payload);
          setStatusLine(`Updated ruleset ${rulesetForm.name}.`);
        } else {
          await client.createRuleset(payload);
          setStatusLine(`Created ruleset ${rulesetForm.name}.`);
        }
      } else if (modal.type === "auth") {
        const payload: CreateAuthProfileInput = {
          name: authForm.name,
          headers: parseHeadersFromLines(authForm.lines),
        };
        if (modal.mode === "edit" && modal.profileId) {
          await client.updateAuthProfile(modal.profileId, payload);
          setStatusLine(`Updated auth profile ${authForm.name}.`);
        } else {
          await client.createAuthProfile(payload);
          setStatusLine(`Created auth profile ${authForm.name}.`);
        }
      } else if (modal.type === "settings") {
        const nextSettings = await client.updateSettings({
          defaultDownloadDir: settingsForm.defaultDownloadDir,
          globalConcurrency: Number(settingsForm.globalConcurrency),
          perHostConcurrency: Number(settingsForm.perHostConcurrency),
          quietHours: settingsForm.quietHours || null,
          clipboardWatcherEnabled: settingsForm.clipboardWatcherEnabled,
          notifyOnComplete: settingsForm.notifyOnComplete,
        });
        setSettings(nextSettings);
        setStatusLine("Settings updated.");
      }

      setModal(null);
      await refreshAll(false);
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : String(error));
    }
  }

  const contextActions =
    activeTab === "Queue" || activeTab === "History"
      ? "A add  P toggle  X cancel  R retry  D rm  E retry"
      : activeTab === "Rules"
        ? "A create  E edit  D del"
        : activeTab === "Auth"
          ? "A create  E edit  D del"
          : activeTab === "Settings"
            ? "A/E edit settings"
            : "A add  / filter";

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg} padding={1}>
      <box
        border
        borderStyle="single"
        borderColor={COLORS.border}
        height={3}
        paddingLeft={1}
        paddingRight={1}
        marginBottom={1}
        backgroundColor={COLORS.surface}
        flexDirection="row"
        columnGap={1}
      >
        <text fg={COLORS.text}>dlm</text>
        <text fg={COLORS.dim}>daemon</text>
        <text fg={COLORS.accent}>{daemonStatus ? `${daemonStatus.active} active / ${daemonStatus.queue} queued` : "..."}</text>
        <text fg={COLORS.dim}>history</text>
        <text fg={COLORS.text}>{daemonStatus?.history ?? 0}</text>
        <text fg={COLORS.dim}>page</text>
        <text fg={COLORS.text}>{`${tabIndex + 1}/${TABS.length} ${activeTab}`}</text>
        <text fg={COLORS.dim}>focus</text>
        <text fg={paneFocus === "list" ? COLORS.accent : COLORS.muted}>{paneFocus}</text>
      </box>

      <box flexDirection="row" flexGrow={1} columnGap={1}>
        <box
          width={16}
          border
          borderStyle="single"
          borderColor={paneFocus === "list" ? COLORS.accent : COLORS.border}
          backgroundColor={COLORS.surface}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          {TABS.map((tab, index) => (
            <text key={tab} fg={index === tabIndex ? COLORS.accent : COLORS.text}>
              {index === tabIndex ? `>${TAB_KEYS[index]} ${tab}` : ` ${TAB_KEYS[index]} ${tab}`}
            </text>
          ))}
          <text fg={COLORS.dim}>Filter</text>
          <text fg={COLORS.text}>{filter || "none"}</text>
        </box>

        <scrollbox
          width="38%"
          border
          borderStyle="single"
          borderColor={paneFocus === "list" ? COLORS.accent : COLORS.border}
          backgroundColor={COLORS.surface}
          title={activeTab}
          padding={1}
        >
          {activeTab === "Queue" && renderDownloadList(filteredDownloads, activeSelection)}
          {activeTab === "History" && renderDownloadList(filteredHistory, activeSelection)}
          {activeTab === "Rules" && renderRulesList(filteredRulesets, activeSelection)}
          {activeTab === "Auth" && renderAuthList(filteredAuthProfiles, activeSelection)}
          {activeTab === "Settings" && renderSettingsSummary(settings, daemonStatus)}
          {activeTab === "Activity" && renderEventList(filteredEvents, activeSelection)}
        </scrollbox>

        <scrollbox
          flexGrow={1}
          border
          borderStyle="single"
          borderColor={paneFocus === "detail" ? COLORS.accent : COLORS.border}
          backgroundColor={COLORS.surfaceAlt}
          title="Details"
          padding={1}
        >
          {activeTab === "Queue" || activeTab === "History"
            ? renderDownloadDetailPane(downloadDetails)
            : activeTab === "Rules"
              ? renderRuleDetailPane(selectedRuleset)
              : activeTab === "Auth"
                ? renderAuthDetailPane(selectedProfile)
                : activeTab === "Settings"
                  ? renderSettingsDetailPane(settings, daemonStatus)
                  : renderEventDetailPane(selectedEvent)}
        </scrollbox>
      </box>

      <box
        border
        borderStyle="single"
        borderColor={COLORS.border}
        height={3}
        backgroundColor={COLORS.surface}
        marginTop={1}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
      >
        <text fg={COLORS.accent}>{statusLine}</text>
      </box>
      <box
        border
        borderStyle="single"
        borderColor={COLORS.border}
        height={4}
        backgroundColor={COLORS.surface}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
      >
        <text fg={COLORS.muted}>{contextActions}</text>
        <text fg={COLORS.dim}>Pages 1-6 or Left/Right  Move Up/Down  Pane Tab  Filter /  Help ?  Quit Q</text>
      </box>

      {showHelp ? (
        <Overlay title="Help">
          <text fg={COLORS.text}>Use 1-6 or Left/Right to switch pages. Queue, History, Rules, Auth, Settings, Activity.</text>
          <text fg={COLORS.text}>Use Up/Down to move in the current list and Tab to switch between list and details.</text>
          <text fg={COLORS.text}>Queue and History use A/P/X/R/D. Rules and Auth use A/E/D. Settings use A or E.</text>
          <text fg={COLORS.text}>Add and Import accept URLs, curl/fetch snippets, and HAR files. HAR imports can queue multiple requests.</text>
          <text fg={COLORS.muted}>Press ? again to close.</text>
        </Overlay>
      ) : null}

      {modal ? (
        <ModalOverlay title={modalTitle(modal)}>
          {modal.type === "confirm-quit" ? (
            <>
              <text fg={COLORS.text}>Downloads are still running.</text>
              <text fg={COLORS.muted}>Press Y to pause all downloads and quit, or N/Esc to stay.</text>
            </>
          ) : null}

          {modal.type === "add" ? (
            <>
              <LabeledInput
                title="Source"
                value={addForm.source}
                focused={fieldFocus === "one"}
                placeholder="URL, curl, fetch, or HAR file"
                onInput={(value) => setAddForm((current) => ({ ...current, source: value }))}
                onSubmit={() => setFieldFocus("two")}
              />
              <LabeledInput
                title="Destination"
                value={addForm.destinationDir}
                focused={fieldFocus === "two"}
                placeholder="Download directory"
                onInput={(value) => setAddForm((current) => ({ ...current, destinationDir: value }))}
                onSubmit={() => setFieldFocus("three")}
              />
              <LabeledInput
                title="Filename"
                value={addForm.filename}
                focused={fieldFocus === "three"}
                placeholder="Optional override"
                onInput={(value) => setAddForm((current) => ({ ...current, filename: value }))}
                onSubmit={() => setFieldFocus("four")}
              />
              <ChoiceRow
                title="Auth Profile"
                focused={fieldFocus === "four"}
                value={describeById(authProfiles, addForm.authProfileId, "none")}
                hint="Left/Right cycles"
              />
              <ChoiceRow
                title="Ruleset"
                focused={fieldFocus === "five"}
                value={describeById(rulesets, addForm.rulesetId, "none")}
                hint="Left/Right cycles"
              />
              <ChoiceRow
                title="Conflict"
                focused={fieldFocus === "six"}
                value={addForm.conflictStrategy}
                hint="Left/Right cycles"
              />
              <SubmitHint />
            </>
          ) : null}

          {modal.type === "import" ? (
            <>
              <LabeledInput
                title="Source"
                value={importForm.source}
                focused={fieldFocus === "one"}
                placeholder="Paste a URL, curl/fetch snippet, or HAR file"
                onInput={(value) => setImportForm((current) => ({ ...current, source: value }))}
                onSubmit={() => setFieldFocus("two")}
              />
              <ChoiceRow
                title="Queue After Parse"
                focused={fieldFocus === "two"}
                value={importForm.queueAfterParse ? "yes" : "no"}
                hint="Left/Right toggles"
              />
              <LabeledInput
                title="Destination"
                value={importForm.destinationDir}
                focused={fieldFocus === "three"}
                placeholder="Used only when queueing"
                onInput={(value) => setImportForm((current) => ({ ...current, destinationDir: value }))}
                onSubmit={() => void submitModal()}
              />
              <SubmitHint />
            </>
          ) : null}

          {modal.type === "filter" ? (
            <>
              <LabeledInput
                title="Filter"
                value={filterDraft}
                focused={fieldFocus === "one"}
                placeholder="Type to narrow the active tab"
                onInput={setFilterDraft}
                onSubmit={() => void submitModal()}
              />
              <SubmitHint />
            </>
          ) : null}

          {modal.type === "ruleset" ? (
            <>
              <LabeledInput
                title="Name"
                value={rulesetForm.name}
                focused={fieldFocus === "one"}
                placeholder="Ruleset name"
                onInput={(value) => setRulesetForm((current) => ({ ...current, name: value }))}
                onSubmit={() => setFieldFocus("two")}
              />
              <LabeledInput
                title="Host Matcher"
                value={rulesetForm.host}
                focused={fieldFocus === "two"}
                placeholder="example.com"
                onInput={(value) => setRulesetForm((current) => ({ ...current, host: value }))}
                onSubmit={() => setFieldFocus("three")}
              />
              <LabeledInput
                title="Destination"
                value={rulesetForm.destinationDir}
                focused={fieldFocus === "three"}
                placeholder="Auto destination directory"
                onInput={(value) => setRulesetForm((current) => ({ ...current, destinationDir: value }))}
                onSubmit={() => setFieldFocus("four")}
              />
              <LabeledInput
                title="Schedule"
                value={rulesetForm.scheduleWindow}
                focused={fieldFocus === "four"}
                placeholder="daily@09:00-17:00"
                onInput={(value) => setRulesetForm((current) => ({ ...current, scheduleWindow: value }))}
                onSubmit={() => setFieldFocus("five")}
              />
              <LabeledInput
                title="Max Segments"
                value={rulesetForm.maxSegments}
                focused={fieldFocus === "five"}
                placeholder="4"
                onInput={(value) => setRulesetForm((current) => ({ ...current, maxSegments: value }))}
                onSubmit={() => setFieldFocus("six")}
              />
              <ChoiceRow
                title="Auth Profile"
                focused={fieldFocus === "six"}
                value={describeById(authProfiles, rulesetForm.authProfileId, "none")}
                hint="Left/Right cycles"
              />
              <SubmitHint />
            </>
          ) : null}

          {modal.type === "auth" ? (
            <>
              <LabeledInput
                title="Name"
                value={authForm.name}
                focused={fieldFocus === "one"}
                placeholder="Profile name"
                onInput={(value) => setAuthForm((current) => ({ ...current, name: value }))}
                onSubmit={() => setFieldFocus("two")}
              />
              <LabeledInput
                title="Headers"
                value={authForm.lines}
                focused={fieldFocus === "two"}
                placeholder="Authorization: Bearer … | X-Header: value"
                onInput={(value) => setAuthForm((current) => ({ ...current, lines: value }))}
                onSubmit={() => void submitModal()}
              />
              <text fg={COLORS.muted}>Use ` | ` between multiple headers.</text>
              <SubmitHint />
            </>
          ) : null}

          {modal.type === "settings" ? (
            <>
              <LabeledInput
                title="Default Dir"
                value={settingsForm.defaultDownloadDir}
                focused={fieldFocus === "one"}
                placeholder="Default download directory"
                onInput={(value) => setSettingsForm((current) => ({ ...current, defaultDownloadDir: value }))}
                onSubmit={() => setFieldFocus("two")}
              />
              <LabeledInput
                title="Global Concurrency"
                value={settingsForm.globalConcurrency}
                focused={fieldFocus === "two"}
                placeholder="3"
                onInput={(value) => setSettingsForm((current) => ({ ...current, globalConcurrency: value }))}
                onSubmit={() => setFieldFocus("three")}
              />
              <LabeledInput
                title="Per-Host Concurrency"
                value={settingsForm.perHostConcurrency}
                focused={fieldFocus === "three"}
                placeholder="2"
                onInput={(value) => setSettingsForm((current) => ({ ...current, perHostConcurrency: value }))}
                onSubmit={() => setFieldFocus("four")}
              />
              <LabeledInput
                title="Quiet Hours"
                value={settingsForm.quietHours}
                focused={fieldFocus === "four"}
                placeholder="daily@22:00-06:00 or always"
                onInput={(value) => setSettingsForm((current) => ({ ...current, quietHours: value }))}
                onSubmit={() => setFieldFocus("five")}
              />
              <ChoiceRow
                title="Clipboard Watcher"
                focused={fieldFocus === "five"}
                value={settingsForm.clipboardWatcherEnabled ? "enabled" : "disabled"}
                hint="Left/Right toggles"
              />
              <ChoiceRow
                title="Notify On Complete"
                focused={fieldFocus === "six"}
                value={settingsForm.notifyOnComplete ? "enabled" : "disabled"}
                hint="Left/Right toggles"
              />
              <SubmitHint />
            </>
          ) : null}
        </ModalOverlay>
      ) : null}
    </box>
  );
}

function renderDownloadList(items: DownloadView[], selectedIndex: number) {
  if (items.length === 0) {
    return <text fg={COLORS.dim}>No downloads.</text>;
  }
  return items.map((item, index) => (
    <box
      key={item.id}
      border={index === selectedIndex}
      borderStyle="single"
      borderColor={index === selectedIndex ? COLORS.accent : COLORS.border}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      flexDirection="column"
    >
      <text fg={index === selectedIndex ? COLORS.text : COLORS.muted}>{item.fileName}</text>
      <text fg={COLORS.dim}>{item.status}</text>
      <text fg={COLORS.dim}>
        {formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)}
      </text>
      <text fg={COLORS.dim}>
        {formatSpeed(item.speedBytesPerSec)}  ETA {formatDuration(item.etaSeconds)}
      </text>
    </box>
  ));
}

function renderRulesList(items: Ruleset[], selectedIndex: number) {
  if (items.length === 0) {
    return <text fg={COLORS.dim}>No rulesets.</text>;
  }
  return items.map((item, index) => (
    <box
      key={item.id}
      border={index === selectedIndex}
      borderStyle="single"
      borderColor={index === selectedIndex ? COLORS.accent : COLORS.border}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      flexDirection="column"
    >
      <text fg={index === selectedIndex ? COLORS.text : COLORS.muted}>{item.name}</text>
      <text fg={COLORS.dim}>{item.enabled ? "enabled" : "disabled"}</text>
      <text fg={COLORS.dim}>{item.matchers.length} matcher(s), {item.actions.length} action(s)</text>
    </box>
  ));
}

function renderAuthList(items: AuthProfile[], selectedIndex: number) {
  if (items.length === 0) {
    return <text fg={COLORS.dim}>No auth profiles.</text>;
  }
  return items.map((item, index) => (
    <box
      key={item.id}
      border={index === selectedIndex}
      borderStyle="single"
      borderColor={index === selectedIndex ? COLORS.accent : COLORS.border}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      flexDirection="column"
    >
      <text fg={index === selectedIndex ? COLORS.text : COLORS.muted}>{item.name}</text>
      <text fg={COLORS.dim}>{Object.keys(item.headers).length} header(s)</text>
    </box>
  ));
}

function renderSettingsSummary(
  settings: AppSettings | null,
  daemonStatus: {
    ok: boolean;
    active: number;
    history: number;
    queue: number;
    clipboardWatcherEnabled: boolean;
  } | null,
) {
  if (!settings) {
    return <text fg={COLORS.dim}>Loading settings…</text>;
  }
  return (
    <>
      <text fg={COLORS.text}>Daemon</text>
      <text fg={COLORS.dim}>Active {daemonStatus?.active ?? 0}</text>
      <text fg={COLORS.dim}>Queued {daemonStatus?.queue ?? 0}</text>
      <text fg={COLORS.dim}>History {daemonStatus?.history ?? 0}</text>
      <text fg={COLORS.text}>Settings</text>
      <text fg={COLORS.dim}>Default dir: {settings.defaultDownloadDir}</text>
      <text fg={COLORS.dim}>Global concurrency: {settings.globalConcurrency}</text>
      <text fg={COLORS.dim}>Per-host concurrency: {settings.perHostConcurrency}</text>
      <text fg={COLORS.dim}>Quiet hours: {settings.quietHours ?? "none"}</text>
      <text fg={COLORS.dim}>Clipboard watcher: {settings.clipboardWatcherEnabled ? "on" : "off"}</text>
    </>
  );
}

function renderEventList(items: DaemonEvent[], selectedIndex: number) {
  if (items.length === 0) {
    return <text fg={COLORS.dim}>No events.</text>;
  }
  return items.map((item, index) => (
    <box
      key={item.id}
      border={index === selectedIndex}
      borderStyle="single"
      borderColor={index === selectedIndex ? COLORS.accent : COLORS.border}
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      flexDirection="column"
    >
      <text fg={index === selectedIndex ? COLORS.text : COLORS.muted}>{item.type}</text>
      <text fg={COLORS.dim}>{item.downloadId ?? "system"}</text>
      <text fg={COLORS.dim}>{item.timestamp}</text>
    </box>
  ));
}

function renderDownloadDetailPane(details: DownloadDetails | null) {
  if (!details) {
    return <text fg={COLORS.dim}>Select a download to see details.</text>;
  }
  return (
    <>
      <text fg={COLORS.text}>{details.download.targetFilename}</text>
      <text fg={COLORS.dim}>{details.download.url}</text>
      <text fg={COLORS.dim}>{details.download.status}</text>
      <text fg={COLORS.dim}>
        {formatBytes(details.download.downloadedBytes)} / {formatBytes(details.download.totalBytes)}
      </text>
      <text fg={COLORS.dim}>Strategy: {details.download.strategy}</text>
      <text fg={COLORS.dim}>Conflict: {details.download.conflictStrategy}</text>
      <text fg={COLORS.dim}>Destination: {details.download.finalPath}</text>
      <text fg={COLORS.dim}>Headers: {Object.keys(details.resolvedHeaders).length}</text>
      {details.download.errorMessage ? <text fg={COLORS.danger}>Error: {details.download.errorMessage}</text> : null}
      <text fg={COLORS.text}>Segments</text>
      {details.segments.length === 0 ? (
        <text fg={COLORS.dim}>No segmented data.</text>
      ) : (
        details.segments.map((segment) => (
          <text key={segment.id} fg={COLORS.dim}>
            #{segment.segmentIndex} {segment.status} {segment.startByte}-{segment.endByte ?? "*"} {formatBytes(segment.downloadedBytes)}
          </text>
        ))
      )}
      <text fg={COLORS.text}>Attempts</text>
      {details.attempts.length === 0 ? (
        <text fg={COLORS.dim}>No retry history.</text>
      ) : (
        details.attempts.map((attempt) => (
          <text key={attempt.id} fg={COLORS.dim}>
            #{attempt.attempt} {attempt.status} {attempt.reason} {attempt.message ?? ""}
          </text>
        ))
      )}
      <text fg={COLORS.text}>Postprocess</text>
      {details.postprocessJobs.length === 0 ? (
        <text fg={COLORS.dim}>No postprocess jobs.</text>
      ) : (
        details.postprocessJobs.map((job) => (
          <text key={job.id} fg={COLORS.dim}>
            {job.step} {job.status} {job.message ?? ""}
          </text>
        ))
      )}
    </>
  );
}

function renderRuleDetailPane(ruleset: Ruleset | null) {
  if (!ruleset) {
    return <text fg={COLORS.dim}>Select a ruleset to inspect or edit it.</text>;
  }
  return (
    <>
      <text fg={COLORS.text}>{ruleset.name}</text>
      <text fg={COLORS.dim}>{ruleset.enabled ? "enabled" : "disabled"}</text>
      <text fg={COLORS.dim}>Priority {ruleset.priority}</text>
      <text fg={COLORS.text}>Matchers</text>
      {ruleset.matchers.length === 0 ? (
        <text fg={COLORS.dim}>No matchers configured.</text>
      ) : (
        ruleset.matchers.map((matcher, index) => (
          <text key={`${ruleset.id}-matcher-${index}`} fg={COLORS.dim}>
            {describeMatcher(matcher)}
          </text>
        ))
      )}
      <text fg={COLORS.text}>Actions</text>
      {ruleset.actions.length === 0 ? (
        <text fg={COLORS.dim}>No actions configured.</text>
      ) : (
        ruleset.actions.map((action, index) => (
          <text key={`${ruleset.id}-action-${index}`} fg={COLORS.dim}>
            {describeAction(action)}
          </text>
        ))
      )}
    </>
  );
}

function renderAuthDetailPane(profile: AuthProfile | null) {
  if (!profile) {
    return <text fg={COLORS.dim}>Select an auth profile to inspect or edit it.</text>;
  }
  return (
    <>
      <text fg={COLORS.text}>{profile.name}</text>
      <text fg={COLORS.dim}>{profile.id}</text>
      {Object.entries(profile.headers).length === 0 ? (
        <text fg={COLORS.dim}>No headers.</text>
      ) : (
        Object.entries(profile.headers).map(([key, value]) => (
          <text key={`${profile.id}-${key}`} fg={COLORS.dim}>
            {key}: {value}
          </text>
        ))
      )}
    </>
  );
}

function renderSettingsDetailPane(
  settings: AppSettings | null,
  daemonStatus: {
    ok: boolean;
    active: number;
    history: number;
    queue: number;
    clipboardWatcherEnabled: boolean;
  } | null,
) {
  if (!settings) {
    return <text fg={COLORS.dim}>Loading settings…</text>;
  }
  return (
    <>
      <text fg={COLORS.text}>Daemon Status</text>
      <text fg={COLORS.dim}>Active downloads: {daemonStatus?.active ?? 0}</text>
      <text fg={COLORS.dim}>Queued downloads: {daemonStatus?.queue ?? 0}</text>
      <text fg={COLORS.dim}>History entries: {daemonStatus?.history ?? 0}</text>
      <text fg={COLORS.text}>Configuration</text>
      <text fg={COLORS.dim}>Default dir: {settings.defaultDownloadDir}</text>
      <text fg={COLORS.dim}>Global concurrency: {settings.globalConcurrency}</text>
      <text fg={COLORS.dim}>Per-host concurrency: {settings.perHostConcurrency}</text>
      <text fg={COLORS.dim}>Quiet hours: {settings.quietHours ?? "none"}</text>
      <text fg={COLORS.dim}>Clipboard watcher: {settings.clipboardWatcherEnabled ? "enabled" : "disabled"}</text>
      <text fg={COLORS.dim}>Notify on complete: {settings.notifyOnComplete ? "enabled" : "disabled"}</text>
    </>
  );
}

function renderEventDetailPane(event: DaemonEvent | null) {
  if (!event) {
    return <text fg={COLORS.dim}>Select an event to inspect it.</text>;
  }
  return (
    <>
      <text fg={COLORS.text}>{event.type}</text>
      <text fg={COLORS.dim}>{event.timestamp}</text>
      <text fg={COLORS.dim}>{event.downloadId ?? "system"}</text>
      <text fg={COLORS.dim}>{JSON.stringify(event.payload, null, 2)}</text>
    </>
  );
}

function Overlay({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <box
      position="absolute"
      width="70%"
      left="15%"
      top={3}
      border
      borderStyle="single"
      borderColor={COLORS.border}
      backgroundColor={COLORS.surface}
      padding={1}
      flexDirection="column"
      rowGap={1}
    >
      <text fg={COLORS.text}>{title}</text>
      {children}
    </box>
  );
}

function ModalOverlay({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <box
      position="absolute"
      width="72%"
      left="14%"
      top={3}
      border
      borderStyle="single"
      borderColor={COLORS.accent}
      backgroundColor={COLORS.surface}
      padding={1}
      flexDirection="column"
      rowGap={1}
    >
      <text fg={COLORS.text}>{title}</text>
      {children}
      <text fg={COLORS.dim}>Tab moves between fields. Esc closes the dialog.</text>
    </box>
  );
}

function LabeledInput(props: {
  title: string;
  value: string;
  focused: boolean;
  placeholder: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <box border borderStyle="single" borderColor={props.focused ? COLORS.accent : COLORS.border} title={props.title} paddingLeft={1}>
      <input
        value={props.value}
        focused={props.focused}
        placeholder={props.placeholder}
        onInput={props.onInput}
        onSubmit={() => props.onSubmit()}
      />
    </box>
  );
}

function ChoiceRow(props: { title: string; value: string; focused: boolean; hint: string }) {
  return (
    <box border borderStyle="single" borderColor={props.focused ? COLORS.accent : COLORS.border} paddingLeft={1} paddingRight={1}>
      <text fg={COLORS.muted}>{props.title}</text>
      <text>  </text>
      <text fg={COLORS.text}>{props.value}</text>
      <text>  </text>
      <text fg={COLORS.dim}>{props.hint}</text>
    </box>
  );
}

function SubmitHint() {
  return (
    <box border borderStyle="single" borderColor={COLORS.border} paddingLeft={1} paddingRight={1}>
      <text fg={COLORS.muted}>Submit</text>
      <text>  </text>
      <text fg={COLORS.text}>Press Enter in the last field to submit</text>
    </box>
  );
}

function filterDownloads(items: DownloadView[], filter: string) {
  return items.filter((item) =>
    includesFilter([item.fileName, item.url, item.status, item.host, item.errorMessage ?? ""], filter),
  );
}

function includesFilter(values: string[], filter: string) {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return values.join(" ").toLowerCase().includes(normalized);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function modalTitle(modal: Exclude<ModalState, null>) {
  switch (modal.type) {
    case "add":
      return "Add Download";
    case "import":
      return "Import Request";
    case "filter":
      return "Filter";
    case "ruleset":
      return modal.mode === "edit" ? "Edit Ruleset" : "Create Ruleset";
    case "auth":
      return modal.mode === "edit" ? "Edit Auth Profile" : "Create Auth Profile";
    case "settings":
      return "Edit Settings";
    case "confirm-quit":
      return "Quit";
  }
}

function createDefaultAddForm(defaultDownloadDir: string): AddFormState {
  return {
    source: "",
    destinationDir: defaultDownloadDir,
    filename: "",
    authProfileId: "",
    rulesetId: "",
    conflictStrategy: "auto-rename",
  };
}

function createDefaultRulesetForm(defaultDownloadDir: string): RulesetFormState {
  return {
    name: "",
    host: "",
    destinationDir: defaultDownloadDir,
    scheduleWindow: "",
    maxSegments: "",
    authProfileId: "",
  };
}

function cycleById<T extends { id: string; name: string }>(items: T[], currentId: string, direction: number) {
  const options = [{ id: "", name: "none" }, ...items];
  const currentIndex = Math.max(
    0,
    options.findIndex((item) => item.id === currentId),
  );
  const nextIndex = (currentIndex + direction + options.length) % options.length;
  return options[nextIndex]?.id ?? "";
}

function describeById<T extends { id: string; name: string }>(items: T[], id: string, fallback: string) {
  return items.find((item) => item.id === id)?.name ?? fallback;
}

function cycleConflictStrategy(current: ConflictStrategy, direction: number): ConflictStrategy {
  const values: ConflictStrategy[] = ["auto-rename", "overwrite", "skip"];
  const index = values.indexOf(current);
  return values[(index + direction + values.length) % values.length]!;
}

function extractRulesetForm(ruleset: Ruleset): RulesetFormState {
  return {
    name: ruleset.name,
    host: extractHostMatcher(ruleset),
    destinationDir: extractActionValue(ruleset.actions, "set_destination_dir"),
    scheduleWindow: extractActionValue(ruleset.actions, "set_schedule_window"),
    maxSegments: extractActionValue(ruleset.actions, "set_max_segments"),
    authProfileId: extractActionValue(ruleset.actions, "set_auth_profile"),
  };
}

function extractHostMatcher(ruleset: Ruleset): string {
  const matcher = ruleset.matchers.find((item) => item.type === "host");
  return matcher?.value ?? "";
}

function extractActionValue(actions: RulesetAction[], type: RulesetAction["type"]): string {
  const action = actions.find((item) => item.type === type);
  if (!action) {
    return "";
  }
  if ("value" in action) {
    return String(action.value);
  }
  return "";
}

function buildRulesetPayload(existing: Ruleset | null, form: RulesetFormState): CreateRulesetInput {
  const preservedMatchers = (existing?.matchers ?? []).filter((item) => item.type !== "host");
  const preservedActions = (existing?.actions ?? []).filter(
    (item) =>
      item.type !== "set_destination_dir" &&
      item.type !== "set_schedule_window" &&
      item.type !== "set_max_segments" &&
      item.type !== "set_auth_profile",
  );

  const matchers: RulesetMatcher[] = [
    ...preservedMatchers,
    ...(form.host ? [{ type: "host", value: form.host } satisfies RulesetMatcher] : []),
  ];
  const actions: RulesetAction[] = [
    ...preservedActions,
    ...(form.destinationDir
      ? [{ type: "set_destination_dir", value: form.destinationDir } satisfies RulesetAction]
      : []),
    ...(form.scheduleWindow
      ? [{ type: "set_schedule_window", value: form.scheduleWindow } satisfies RulesetAction]
      : []),
    ...(form.maxSegments
      ? [{ type: "set_max_segments", value: Number(form.maxSegments) } satisfies RulesetAction]
      : []),
    ...(form.authProfileId
      ? [{ type: "set_auth_profile", value: form.authProfileId } satisfies RulesetAction]
      : []),
  ];

  return {
    name: form.name,
    enabled: existing?.enabled ?? true,
    priority: existing?.priority ?? 100,
    matchers,
    actions,
  };
}

function parseHeadersFromLines(lines: string) {
  const headers: Record<string, string> = {};
  for (const rawPart of lines.split("|")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const [key, ...rest] = part.split(":");
    if (!key || rest.length === 0) {
      continue;
    }
    headers[key.trim()] = rest.join(":").trim();
  }
  return headers;
}

function serializeHeaders(headers: Record<string, string>) {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" | ");
}

function describeMatcher(matcher: RulesetMatcher) {
  return matcher.type === "tag" || matcher.type === "host" || matcher.type === "mime" || matcher.type === "extension"
    ? `${matcher.type} = ${matcher.value}`
    : `${matcher.type} = ${matcher.value}`;
}

function describeAction(action: RulesetAction) {
  if (action.type === "toggle_postprocess") {
    return `${action.type} ${action.step} ${action.enabled ? "on" : "off"}`;
  }
  return `${action.type} ${String(action.value)}`;
}
