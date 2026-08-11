import {
  absolutePolygonArea,
  bboxOfPoints,
  bboxesIntersect,
  cleanPolygon,
  csvEscape,
  downloadBlob,
  escapeHtml,
  escapeXml,
  expandBBox,
  formatMm,
  pointInBBox,
  pointInPolygon,
  polygonCentroid,
  rectanglePolygon,
  stableId,
  unionBBoxes
} from './geometry.js';
import { parseCadFile } from './cad-loader.js';
import {
  effectiveOrigin,
  generateLayout,
  nominalTileSize,
  normalizeRotation
} from './layout-engine.js';
import {
  hatchComponentsFromLayer,
  inferAreaHatchLayer
} from './hatch-regions.js';
import { optimizeGroupOrigin } from './origin-optimizer.js';
import {
  countBandsIntersectingComponent,
  detectExpansionJointBands,
  splitHatchComponentsByBands
} from './joint-regions.js';
import { buildRoofTileDxf } from './dxf-exporter.js';

const byId = (id) => document.getElementById(id);
const domIds = [
  'sourceSubtitle','sourceBadge','sourceIcon','openCadButton','autosaveStatus','cadFileInput',
  'layerMappingButton','sourceFileName','sourceDetail','regionCountMetric','exactCountMetric','horizontalCountMetric',
  'verticalCountMetric','sourceNotice','tileLongInput','tileShortInput','jointXInput','jointYInput','staggerEnabledInput','staggerOffsetInput','minCutInput',
  'dimensionDigitsInput','showFullTilesInput','showCutLabelsInput','showCadInput','keepArchitectureInput','resetTileSettings','selectedRegionCount',
  'projectSelect','projectStatus','newProjectButton','renameProjectButton','deleteProjectButton',
  'savedVersionSelect','versionStatus','saveNamedVersionButton','loadNamedVersionButton','deleteNamedVersionButton',
  'exportProjectButton','importProjectButton','projectFileInput','syncKeyInput','uploadSyncButton','downloadSyncButton','syncStatus',
  'mergeRegionsButton','splitRegionsButton','deleteRegionButton','removeHatchButton','selectionHint',
  'canvasFrame','layoutCanvas','viewScaleLabel','cursorCoordinateLabel','calculationBadge',
  'canvasTooltip','stageStatusText','stageInstruction','fitViewButton','zoomSelectionButton','undoButton','activeGroupBadge',
  'activeGroupSelect','unifiedOriginInput','carryAcrossInput','originXInput','originYInput','confirmMoveButton',
  'nudgeUpInput','nudgeDownInput','nudgeLeftInput','nudgeRightInput','optimizeOriginButton','selectedOrientationInput',
  'nudgeStepInput','nudgeButtonUp','nudgeButtonDown','nudgeButtonLeft','nudgeButtonRight','orientationPreview','orientationPreviewTitle','orientationPreviewText','rotateSelectedButton',
  'autoDetectBandsButton','bandWidthInput','bandTypeInput','bandGlobalInput','bandList','conceptualTileMetric',
  'fullTileMetric','cutPieceMetric','continuationMetric','minPieceMetric','smallPieceMetric','warningList','cutSelectedOnlyInput',
  'cutSmallOnlyInput','cutSearchInput','cutTableBody','exportCsvButton','exportSvgButton','exportDxfButton','printButton','layerDialog',
  'regionLayerSelect','layerSummary','applyLayerMappingButton',
  'helpDialog','helpButton','touchActionDialog','touchActionTitle','touchActionText','touchActionContinueButton','touchActionMoveButton','touchActionSplitButton','toastContainer'
];
const dom = Object.fromEntries(domIds.map((id) => [id, byId(id)]));

const DEFAULT_SETTINGS = Object.freeze({
  tileLong: 600,
  tileShort: 300,
  jointX: 5,
  jointY: 5,
  staggerEnabled: true,
  staggerOffset: 300,
  minCut: 100,
  dimensionDigits: 0,
  showFullTiles: true,
  showCutLabels: true,
  showCad: true,
  keepArchitectureOnTop: true
});

const AUTO_PROJECT_KEY = 'roof-tile-layout:auto-project:v1';
const NAMED_VERSIONS_KEY = 'roof-tile-layout:named-versions:v1';
const SYNC_KEY_STORAGE_KEY = 'roof-tile-layout:sync-key:v1';
const SYNC_ENDPOINT = String(document.querySelector?.('meta[name="roof-tile-sync-endpoint"]')?.content || '/api/sync').trim() || '/api/sync';
const PROJECTS_DB_NAME = 'roof-tile-layout-projects-v1';
const PROJECTS_DB_VERSION = 1;
const PROJECTS_STORE_NAME = 'projects';
const PROJECTS_FALLBACK_KEY = 'roof-tile-layout:projects:v1';
const PROJECT_MAX_COUNT = 50;
const BACKUP_SCHEMA_VERSION = 1;
const SOURCE_CHUNK_BYTES = 300000;

const state = {
  qa: null,
  cad: null,
  sourceDxfText: '',
  sourceSyncId: '',
  sourceSyncUploads: new Set(),
  sourceFileName: 'roof tile with area hatched.dxf',
  projectId: null,
  projectName: '',
  projectCatalog: [],
  pendingProjectName: '',
  projectDbPromise: null,
  sourceRegionCount: 0,
  removedHatchKeys: new Set(),
  sourceMode: 'loading',
  regions: [],
  groups: [],
  bands: [],
  settings: { ...DEFAULT_SETTINGS },
  selection: new Set(),
  touchMergeMode: false,
  activeRegionId: null,
  activeGroupId: null,
  mode: 'select',
  layerMapping: { region: 'ROOF_TILE_LAYOUT', joint: '', channel: '', tolerance: 3 },
  layout: { pieces: [], tiles: new Map(), warnings: [], stats: {} },
  view: { centerX: 0, centerY: 0, scale: 0.01 },
  interaction: {
    dragging: false, moved: false, action: null, startScreen: null, startWorld: null, startView: null,
    bandPreview: null, selectionBox: null, selectionBoxModifier: false,
    snapPreview: null, touchPointers: new Map(), pinch: null,
    longPressTimer: 0, longPressRegionId: null, longPress: false, suppressTouchClick: false,
    longPressStart: null,
    zoomQueue: { factor: 1, screen: null, frame: 0 }
  },
  exactCount: 0,
  hatchObjectCount: 0,
  hatchHoleCount: 0,
  removedOverlapRegions: 0,
  baseRegionCount: 0,
  splitRegionCount: 0,
  detectedJointCount: 0,
  history: [],
  renderPending: false,
  calculationTimer: null,
  autoSaveTimer: null,
  initialized: false
};

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`.trim();
  element.textContent = message;
  dom.toastContainer.appendChild(element);
  setTimeout(() => element.remove(), 3400);
}

function setSourceBadge(text, mode) {
  dom.sourceBadge.textContent = text;
  dom.sourceBadge.className = `status-badge status-${mode}`;
}

function setNotice(message, type = 'info') {
  dom.sourceNotice.textContent = message;
  dom.sourceNotice.className = `notice ${type}`;
}

function numeric(input, fallback = 0) {
  const value = Number(input?.value ?? input);
  return Number.isFinite(value) ? value : fallback;
}

function integerMm(input, fallback = 0) {
  return Math.round(numeric(input, fallback));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function isCoarsePointerDevice() {
  const mediaCoarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  const touchPoints = typeof navigator !== 'undefined' ? Number(navigator.maxTouchPoints || 0) : 0;
  const narrowTouchLayout = typeof window !== 'undefined' && Number(window.innerWidth || 0) > 0
    && Number(window.innerWidth) <= 1180;
  return Boolean(mediaCoarse || touchPoints > 0 || narrowTouchLayout);
}

function rotationLabel(rotation, compact = false) {
  const normalized = normalizeRotation(rotation);
  if (compact) return normalized === 90 ? '長→Y' : '長→X';
  return normalized === 90 ? '長邊沿 Y／上下' : '長邊沿 X／左右';
}

function groupById(id) {
  return state.groups.find((group) => group.id === id) || null;
}

function regionById(id) {
  return state.regions.find((region) => region.id === id) || null;
}

function activeRegion() {
  return regionById(state.activeRegionId) || state.regions.find((region) => state.selection.has(region.id)) || null;
}

function activeGroup() {
  return groupById(state.activeGroupId) || groupById(activeRegion()?.groupId) || state.groups[0] || null;
}

function groupMembers(groupId) {
  return state.regions.filter((region) => region.groupId === groupId);
}

function selectedRegions() {
  const selected = state.regions.filter((region) => state.selection.has(region.id));
  if (!selected.length && activeRegion()) return [activeRegion()];
  return selected;
}

function regionSelectionIds(region) {
  if (!region) return [];
  const members = groupMembers(region.groupId);
  return members.length > 1 ? members.map((member) => member.id) : [region.id];
}

function selectRegionSelection(region, { multi = false, toggle = false } = {}) {
  if (!region) {
    if (!multi) state.selection.clear();
    return;
  }
  const targetIds = new Set(regionSelectionIds(region));
  if (!multi) state.selection = targetIds;
  else {
    const allSelected = [...targetIds].every((id) => state.selection.has(id));
    // In touch merge mode, a tap adds an area and never accidentally removes
    // the already highlighted group. Ctrl/Shift retains the desktop toggle.
    if (toggle && allSelected) for (const id of targetIds) state.selection.delete(id);
    else for (const id of targetIds) state.selection.add(id);
  }
  state.activeRegionId = region.id;
  state.activeGroupId = region.groupId || state.activeGroupId;
}

function updateSelectionHint() {
  if (!dom.selectionHint) return;
  dom.selectionHint.classList.toggle('touch-active', state.touchMergeMode);
  dom.selectionHint.textContent = state.touchMergeMode
    ? '觸控合併模式：直接點選相鄰區域加入高亮，完成後按「合併所選」；長按已合併組可取消合併或移動。'
    : '電腦：單點選區；左至右拖曳窗口選取，右至左拖曳交叉選取，Ctrl／Shift 可加入。選好後可移除 HATCH。iPad／手機：長按區域開始合併選取，再點選相鄰區域。';
}

function hatchRegionKey(component = {}) {
  return [
    component.sourceHandle || '',
    component.sourcePathIndex ?? 0,
    component.baseIndex ?? 0,
    component.splitIndex ?? 0
  ].join('|');
}

function currentSourceRegionCount() {
  return Number(state.sourceRegionCount || state.regions.length || 0);
}

function snapshotProject({ includeSource = false } = {}) {
  const baseRegionNumbers = new Set(state.regions.map((region) => region.baseRegionNumber).filter((number) => number != null));
  const inferredHatchAnalysis = !state.hatchObjectCount && state.cad && state.layerMapping.region
    ? hatchComponentsFromLayer(state.cad, state.layerMapping.region)
    : null;
  const inferredHatchObjectCount = Number(state.hatchObjectCount || inferredHatchAnalysis?.hatches?.length || 0);
  const inferredHoleCount = Number(state.hatchHoleCount || state.regions.reduce((count, region) => count + (region.holes?.length || 0), 0));
  const inferredBaseRegionCount = Number(state.baseRegionCount || baseRegionNumbers.size || 0);
  const inferredSplitRegionCount = Number(state.splitRegionCount || state.regions.length || 0);
  const inferredDetectedJointCount = Number(state.detectedJointCount || state.bands.filter((band) => band.source === 'dxf-joint-hatch').length || 0);
  const project = {
    version: 5,
    projectType: 'roof-tile-layout',
    sourceFileName: state.sourceFileName,
    sourceSyncId: state.sourceSyncId || '',
    sourceMode: state.sourceMode,
    sourceRegionCount: currentSourceRegionCount(),
    hatchObjectCount: inferredHatchObjectCount,
    hatchHoleCount: inferredHoleCount,
    removedOverlapRegions: Number(state.removedOverlapRegions || 0),
    baseRegionCount: inferredBaseRegionCount,
    splitRegionCount: inferredSplitRegionCount,
    detectedJointCount: inferredDetectedJointCount,
    exactCount: Number(state.exactCount || 0),
    removedHatchKeys: [...state.removedHatchKeys],
    settings: structuredClone(state.settings),
    regions: structuredClone(state.regions),
    groups: structuredClone(state.groups),
    bands: structuredClone(state.bands),
    layerMapping: structuredClone(state.layerMapping),
    activeGroupId: state.activeGroupId,
    activeRegionId: state.activeRegionId
  };
  if (includeSource) {
    if (state.sourceDxfText) project.sourceDxfText = state.sourceDxfText;
    else if (state.cad) project.cad = structuredClone(state.cad);
  }
  return project;
}

function cloneProjectData(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function projectNameFromFile(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '').trim();
  return base || '未命名 project';
}

function uniqueProjectName(name) {
  const requested = String(name || '').trim() || '未命名 project';
  const used = new Set(state.projectCatalog.map((project) => String(project.name || '').toLowerCase()));
  if (!used.has(requested.toLowerCase())) return requested;
  for (let index = 2; index <= PROJECT_MAX_COUNT + 1; index += 1) {
    const candidate = `${requested} (${index})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${requested} (${Date.now()})`;
}

function normalizeProjectRecord(record = {}) {
  const project = record.project && record.project.projectType === 'roof-tile-layout'
    ? cloneProjectData(record.project)
    : null;
  if (!project) return null;
  return {
    id: String(record.id || stableId('project')),
    name: String(record.name || projectNameFromFile(project.sourceFileName)),
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
    sourceFileName: String(record.sourceFileName || project.sourceFileName || ''),
    sourceRegionCount: Number(record.sourceRegionCount ?? project.sourceRegionCount ?? 0),
    project
  };
}

function openProjectDatabase() {
  if (state.projectDbPromise) return state.projectDbPromise;
  if (!globalThis.indexedDB) return Promise.resolve(null);
  state.projectDbPromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(PROJECTS_DB_NAME, PROJECTS_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROJECTS_STORE_NAME)) {
        request.result.createObjectStore(PROJECTS_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('project database unavailable'));
  });
  return state.projectDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('project storage request failed'));
  });
}

async function loadProjectCatalog() {
  try {
    const db = await openProjectDatabase();
    let records = [];
    if (db) {
      const transaction = db.transaction(PROJECTS_STORE_NAME, 'readonly');
      records = await idbRequest(transaction.objectStore(PROJECTS_STORE_NAME).getAll());
    } else if (typeof localStorage !== 'undefined') {
      records = JSON.parse(localStorage.getItem(PROJECTS_FALLBACK_KEY) || '[]');
    }
    state.projectCatalog = (Array.isArray(records) ? records : [])
      .map(normalizeProjectRecord)
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, PROJECT_MAX_COUNT);
  } catch (error) {
    console.warn('Unable to load project catalog', error);
    state.projectCatalog = [];
  }
  renderProjectControls();
  return state.projectCatalog;
}

async function writeProjectCatalog(records) {
  const normalized = records.map(normalizeProjectRecord).filter(Boolean).slice(0, PROJECT_MAX_COUNT);
  const db = await openProjectDatabase();
  if (db) {
    const transaction = db.transaction(PROJECTS_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(PROJECTS_STORE_NAME);
    store.clear();
    for (const record of normalized) store.put(record);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('project catalog write failed'));
      transaction.onabort = () => reject(transaction.error || new Error('project catalog write aborted'));
    });
  } else if (typeof localStorage !== 'undefined') {
    localStorage.setItem(PROJECTS_FALLBACK_KEY, JSON.stringify(normalized));
  }
  state.projectCatalog = normalized;
  renderProjectControls();
}

async function putProjectRecord(record) {
  const normalized = normalizeProjectRecord(record);
  if (!normalized) return false;
  const index = state.projectCatalog.findIndex((project) => project.id === normalized.id);
  const next = [...state.projectCatalog];
  if (index >= 0) next[index] = normalized;
  else {
    if (next.length >= PROJECT_MAX_COUNT) {
      toast(`最多保存 ${PROJECT_MAX_COUNT} 個 project；請先刪除舊 project。`, 'warning');
      return false;
    }
    next.push(normalized);
  }
  try {
    await writeProjectCatalog(next);
    return true;
  } catch (error) {
    console.warn('Unable to save project record', error);
    toast('project 保存空間不足；請先導出 JSON 備份或刪除舊 project。', 'warning');
    return false;
  }
}

function findProjectRecord(projectId = state.projectId) {
  return state.projectCatalog.find((project) => project.id === projectId) || null;
}

function projectForSync(record) {
  const project = cloneProjectData(record.project || {});
  delete project.sourceDxfText;
  delete project.cad;
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sourceFileName: record.sourceFileName,
    sourceRegionCount: record.sourceRegionCount,
    project
  };
}

function renderProjectControls() {
  if (!dom.projectSelect || !dom.projectStatus) return;
  const selectedId = state.projectId || dom.projectSelect.value || '';
  const projects = [...state.projectCatalog].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'));
  dom.projectSelect.innerHTML = [
    '<option value="">選擇 project</option>',
    ...projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)} · ${escapeHtml(project.sourceFileName || '未命名圖紙')}</option>`)
  ].join('');
  if (projects.some((project) => project.id === selectedId)) dom.projectSelect.value = selectedId;
  dom.projectStatus.textContent = `${state.projectCatalog.length} 個 project`;
  if (dom.renameProjectButton) dom.renameProjectButton.disabled = !state.projectId;
  if (dom.deleteProjectButton) dom.deleteProjectButton.disabled = !state.projectId;
}

function projectSnapshotForStorage({ includeSource = false } = {}) {
  const project = snapshotProject({ includeSource });
  if (!includeSource) {
    const existing = findProjectRecord();
    if (existing?.project?.sourceDxfText) project.sourceDxfText = existing.project.sourceDxfText;
    if (existing?.project?.cad) project.cad = cloneProjectData(existing.project.cad);
  }
  return project;
}

async function persistActiveProject({ includeSource = false, sync = true } = {}) {
  if (!state.projectId || (!state.regions.length && !state.cad)) return false;
  const existing = findProjectRecord();
  if (!existing) return false;
  const project = projectSnapshotForStorage({ includeSource });
  const record = {
    ...existing,
    name: state.projectName || existing.name,
    updatedAt: new Date().toISOString(),
    sourceFileName: state.sourceFileName,
    sourceRegionCount: currentSourceRegionCount(),
    project
  };
  const saved = await putProjectRecord(record);
  if (saved && sync && typeof uploadSync === 'function') {
    const queue = typeof queueMicrotask === 'function' ? queueMicrotask : (callback) => setTimeout(callback, 0);
    queue(() => { void uploadSync({ quiet: true }); });
  }
  return saved;
}

async function activateProjectForCurrentSource({ forceNew = false, name = '', restoreExisting = true } = {}) {
  const sourceFileName = String(state.sourceFileName || '');
  const sourceRegionCount = currentSourceRegionCount();
  const currentRecord = findProjectRecord();
  let record = !forceNew && ((currentRecord
    && currentRecord.sourceFileName === sourceFileName
    && Number(currentRecord.sourceRegionCount) === sourceRegionCount
    ? currentRecord
    : null) || state.projectCatalog.find((project) => (
      project.sourceFileName === sourceFileName && Number(project.sourceRegionCount) === sourceRegionCount
    )));
  if (record) {
    state.projectId = record.id;
    state.projectName = record.name;
    if (restoreExisting && record.project) restoreProject(record.project, true);
    renderProjectControls();
    return true;
  }
  const projectName = uniqueProjectName(name || projectNameFromFile(sourceFileName));
  record = {
    id: stableId('project'),
    name: projectName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceFileName,
    sourceRegionCount: currentSourceRegionCount(),
    project: snapshotProject({ includeSource: true })
  };
  if (!await putProjectRecord(record)) return false;
  state.projectId = record.id;
  state.projectName = record.name;
  renderProjectControls();
  return true;
}

async function mergeSyncedProjects(remoteProjects = []) {
  if (!Array.isArray(remoteProjects) || !remoteProjects.length) return;
  const byId = new Map(state.projectCatalog.map((project) => [project.id, project]));
  for (const remote of remoteProjects) {
    const normalized = normalizeProjectRecord(remote);
    if (!normalized) continue;
    const local = byId.get(normalized.id);
    if (local?.project) {
      if (local.project.sourceDxfText) normalized.project.sourceDxfText = local.project.sourceDxfText;
      if (local.project.cad) normalized.project.cad = cloneProjectData(local.project.cad);
    }
    byId.set(normalized.id, normalized);
  }
  await writeProjectCatalog([...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
}

async function switchProject(projectId) {
  const record = state.projectCatalog.find((project) => project.id === projectId);
  if (!record) return;
  if (record.id === state.projectId) return;
  try {
    await persistActiveProject({ includeSource: true, sync: false });
    const project = record.project;
    if (project.sourceDxfText) {
      const buffer = new TextEncoder().encode(project.sourceDxfText).buffer;
      await loadCadBuffer(buffer, project.sourceFileName, {
        initial: false,
        restoreAuto: false,
        activateProject: false,
        skipProjectPersist: true
      });
    } else if (project.cad) {
      state.cad = cloneProjectData(project.cad);
      state.sourceFileName = project.sourceFileName || state.sourceFileName;
    } else if (project.sourceSyncId && readSyncKey()) {
      const source = await downloadSourceSync(readSyncKey(), project.sourceSyncId);
      if (source?.sourceDxfText) {
        await loadCadBuffer(new TextEncoder().encode(source.sourceDxfText).buffer, source.sourceFileName || project.sourceFileName, {
          initial: false,
          restoreAuto: false,
          activateProject: false,
          skipProjectPersist: true
        });
        state.sourceSyncId = source.sourceId;
        state.sourceSyncUploads.add(sourceSyncCacheKey(readSyncKey(), source.sourceId));
      } else {
        state.cad = null;
        state.sourceFileName = project.sourceFileName || state.sourceFileName;
      }
    } else {
      state.cad = null;
      state.sourceFileName = project.sourceFileName || state.sourceFileName;
    }
    state.projectId = record.id;
    state.projectName = record.name;
    restoreProject(project, Boolean(project.sourceDxfText || project.cad));
    if (!project.sourceDxfText && !project.cad) state.sourceMode = 'cloud';
    await persistActiveProject({ includeSource: Boolean(project.sourceDxfText || project.cad), sync: false });
    renderAllControls();
    scheduleAutoSave();
    toast(`已切換至 project「${record.name}」。`, 'success');
  } catch (error) {
    console.error(error);
    renderProjectControls();
    toast(`project 切換失敗：${error.message}`, 'error');
  }
}

async function renameCurrentProject() {
  const record = findProjectRecord();
  if (!record) return toast('目前沒有可改名的 project。', 'warning');
  const name = window.prompt('請輸入 project 名稱。', record.name)?.trim();
  if (!name || name === record.name) return;
  const duplicate = state.projectCatalog.some((project) => project.id !== record.id && project.name.toLowerCase() === name.toLowerCase());
  if (duplicate) return toast('已有相同名稱的 project，請換一個名稱。', 'warning');
  state.projectName = name;
  await putProjectRecord({ ...record, name, updatedAt: new Date().toISOString() });
  renderProjectControls();
  toast(`project 已改名為「${name}」。`, 'success');
}

async function deleteCurrentProject() {
  const record = findProjectRecord();
  if (!record) return toast('目前沒有可刪除的 project。', 'warning');
  if (state.projectCatalog.length <= 1) return toast('至少保留一個 project；如要開始新圖紙，直接按「新建 project」。', 'warning');
  if (!window.confirm(`確定刪除 project「${record.name}」？此 project 的排布設定會一併刪除。`)) return;
  const next = state.projectCatalog.filter((project) => project.id !== record.id);
  const nextProject = next[0];
  await writeProjectCatalog(next);
  state.projectId = null;
  state.projectName = '';
  await switchProject(nextProject.id);
  toast(`project「${record.name}」已刪除。`, 'success');
}

function readSyncKey() {
  const inputValue = String(dom.syncKeyInput?.value || '').trim();
  if (inputValue) return inputValue;
  if (typeof localStorage === 'undefined') return '';
  try { return String(localStorage.getItem(SYNC_KEY_STORAGE_KEY) || '').trim(); }
  catch { return ''; }
}

function rememberSyncKey(value) {
  const key = String(value || '').trim();
  if (dom.syncKeyInput) dom.syncKeyInput.value = key;
  if (typeof localStorage === 'undefined') return;
  try {
    if (key) localStorage.setItem(SYNC_KEY_STORAGE_KEY, key);
    else localStorage.removeItem(SYNC_KEY_STORAGE_KEY);
  } catch (error) { console.warn('Unable to store sync key', error); }
}

function setSyncStatus(message, type = '') {
  if (!dom.syncStatus) return;
  dom.syncStatus.textContent = message;
  dom.syncStatus.className = type ? `sync-status ${type}` : 'sync-status';
}

function buildBackupBundle() {
  return {
    schema: BACKUP_SCHEMA_VERSION,
    projectType: 'roof-tile-layout-backup',
    exportedAt: new Date().toISOString(),
    activeProjectId: state.projectId,
    projects: cloneProjectData(state.projectCatalog),
    currentProject: snapshotProject({ includeSource: true }),
    namedVersions: readNamedVersions()
  };
}

function buildSyncBundle() {
  return {
    schema: BACKUP_SCHEMA_VERSION,
    projectType: 'roof-tile-layout-sync',
    updatedAt: new Date().toISOString(),
    activeProjectId: state.projectId,
    sourceFileName: state.sourceFileName,
    currentProject: snapshotProject(),
    projects: state.projectCatalog.map(projectForSync),
    namedVersions: readNamedVersions()
  };
}

async function exportProjectBackup() {
  try {
    await persistActiveProject({ includeSource: true, sync: false });
    const json = JSON.stringify(buildBackupBundle(), null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(json, `Roof-Tile-Layout-Backup-${stamp}.json`, 'application/json;charset=utf-8');
    toast('佈局、合併、起點及版本資料已導出 JSON。', 'success');
  } catch (error) {
    console.error(error);
    toast('佈局導出失敗，請稍後再試。', 'error');
  }
}

async function importProjectBackup(file) {
  if (!file) return;
  try {
    const bundle = JSON.parse(await file.text());
    const project = bundle?.currentProject || bundle?.project;
    if (bundle?.projectType !== 'roof-tile-layout-backup' || project?.projectType !== 'roof-tile-layout') {
      throw new Error('不是屋面瓷磚排布 JSON 備份。');
    }
    pushHistory();
    if (Array.isArray(bundle.projects) && bundle.projects.length) await writeProjectCatalog(bundle.projects);
    if (bundle.namedVersions && typeof bundle.namedVersions === 'object') writeNamedVersions(bundle.namedVersions, { sync: false });
    const activeProject = Array.isArray(bundle.projects)
      ? state.projectCatalog.find((item) => item.id === bundle.activeProjectId) || state.projectCatalog[0]
      : null;
    const activeProjectData = activeProject?.project || project;
    if (activeProjectData.sourceDxfText) {
      const buffer = new TextEncoder().encode(activeProjectData.sourceDxfText).buffer;
      await loadCadBuffer(buffer, activeProjectData.sourceFileName, { initial: false, restoreAuto: false, activateProject: false, skipProjectPersist: true });
    }
    restoreProject(activeProjectData, true);
    if (activeProject) {
      state.projectId = activeProject.id;
      state.projectName = activeProject.name;
    } else {
      await activateProjectForCurrentSource({ forceNew: true, name: projectNameFromFile(project.sourceFileName), restoreExisting: false });
    }
    await persistActiveProject({ includeSource: true, sync: false });
    renderNamedVersions();
    scheduleAutoSave();
    toast('JSON 備份已導入，版本及排布設定已恢復。', 'success');
  } catch (error) {
    console.error(error);
    toast(error.message || 'JSON 備份導入失敗。', 'error');
  } finally {
    if (dom.projectFileInput) dom.projectFileInput.value = '';
  }
}

async function syncRequest(action, syncKey, payload = null) {
  const response = await fetch(SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, syncKey, payload })
  });
  let result = null;
  try { result = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !result?.ok) throw new Error(result?.message || `同步服務 ${response.status}`);
  return result;
}

function sourceSyncCacheKey(syncKey, sourceId) {
  return `${syncKey}:${sourceId}`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function prepareSourceSync() {
  if (!state.sourceDxfText) return null;
  const bytes = new TextEncoder().encode(state.sourceDxfText);
  const sourceId = state.sourceSyncId || await sha256Hex(bytes);
  state.sourceSyncId = sourceId;
  return { sourceId, bytes, sourceFileName: state.sourceFileName };
}

async function uploadSourceSync(syncKey, sourceInfo) {
  if (!sourceInfo?.bytes?.length) return;
  const cacheKey = sourceSyncCacheKey(syncKey, sourceInfo.sourceId);
  if (state.sourceSyncUploads.has(cacheKey)) return;
  const chunkCount = Math.ceil(sourceInfo.bytes.length / SOURCE_CHUNK_BYTES);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * SOURCE_CHUNK_BYTES;
    const chunk = sourceInfo.bytes.subarray(start, Math.min(start + SOURCE_CHUNK_BYTES, sourceInfo.bytes.length));
    await syncRequest('put-source', syncKey, {
      sourceId: sourceInfo.sourceId,
      sourceFileName: sourceInfo.sourceFileName,
      chunkIndex,
      chunkCount,
      data: bytesToBase64(chunk)
    });
  }
  state.sourceSyncUploads.add(cacheKey);
}

async function downloadSourceSync(syncKey, sourceId) {
  if (!sourceId) return null;
  const first = await syncRequest('get-source', syncKey, { sourceId, chunkIndex: 0 });
  const chunkCount = Math.max(1, Number(first.chunkCount || 1));
  const chunks = [base64ToBytes(first.data)];
  for (let chunkIndex = 1; chunkIndex < chunkCount; chunkIndex += 1) {
    const result = await syncRequest('get-source', syncKey, { sourceId, chunkIndex });
    chunks.push(base64ToBytes(result.data));
  }
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    sourceId,
    sourceFileName: first.sourceFileName || '',
    sourceDxfText: new TextDecoder().decode(bytes)
  };
}

async function uploadSync({ quiet = false } = {}) {
  const syncKey = readSyncKey();
  if (!syncKey) {
    if (!quiet) toast('請先輸入同步碼。', 'warning');
    return false;
  }
  if (syncKey.length < 6) {
    if (!quiet) toast('同步碼至少需要 6 個字元。', 'warning');
    return false;
  }
  rememberSyncKey(syncKey);
  setSyncStatus('上傳中…');
  try {
    await persistActiveProject({ includeSource: false, sync: false });
    const sourceInfo = await prepareSourceSync();
    if (sourceInfo) {
      await uploadSourceSync(syncKey, sourceInfo);
      await persistActiveProject({ includeSource: false, sync: false });
    }
    const payload = buildSyncBundle();
    const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (size > 900000) throw new Error('同步資料超過雲端單次保存上限，請使用導出 JSON 備份。');
    const result = await syncRequest('put', syncKey, payload);
    setSyncStatus(`已同步 ${new Date(result.updatedAt || payload.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'saved');
    if (!quiet) toast('目前佈局及命名版本已上傳到雲端。', 'success');
    return true;
  } catch (error) {
    console.error(error);
    setSyncStatus('同步失敗', 'error');
    if (!quiet) toast(`雲端上傳失敗：${error.message}`, 'error');
    return false;
  }
}

async function downloadSync() {
  const syncKey = readSyncKey();
  if (!syncKey) return toast('請先輸入同步碼。', 'warning');
  if (syncKey.length < 6) return toast('同步碼至少需要 6 個字元。', 'warning');
  rememberSyncKey(syncKey);
  setSyncStatus('載入中…');
  try {
    const result = await syncRequest('get', syncKey);
    const payload = result.payload;
    const project = payload?.currentProject;
    if (!project || project.projectType !== 'roof-tile-layout') throw new Error('雲端沒有可用的屋面佈局。');
    pushHistory();
    if (Array.isArray(payload.projects)) await mergeSyncedProjects(payload.projects);
    if (payload.namedVersions && typeof payload.namedVersions === 'object') writeNamedVersions(payload.namedVersions, { sync: false });
    let restoredSource = false;
    if (project.sourceSyncId) {
      try {
        const source = await downloadSourceSync(syncKey, project.sourceSyncId);
        if (source?.sourceDxfText) {
          await loadCadBuffer(new TextEncoder().encode(source.sourceDxfText).buffer, source.sourceFileName || project.sourceFileName, {
            initial: false,
            restoreAuto: false,
            activateProject: false,
            skipProjectPersist: true
          });
          state.sourceSyncId = source.sourceId;
          state.sourceSyncUploads.add(sourceSyncCacheKey(syncKey, source.sourceId));
          restoredSource = true;
        }
      } catch (sourceError) {
        console.warn('Unable to restore synced CAD background', sourceError);
      }
    }
    const sameSource = String(project.sourceFileName || '') === String(state.sourceFileName || '')
      && Number(project.sourceRegionCount || 0) === currentSourceRegionCount();
    restoreProject(project, restoredSource || sameSource);
    const syncedProject = state.projectCatalog.find((item) => item.id === payload.activeProjectId);
    state.projectId = syncedProject?.id || state.projectId;
    state.projectName = syncedProject?.name || state.projectName || projectNameFromFile(project.sourceFileName);
    if (state.projectId) await persistActiveProject({ includeSource: restoredSource || sameSource, sync: false });
    renderNamedVersions();
    scheduleAutoSave();
    const updatedAt = payload.updatedAt || result.updatedAt;
    setSyncStatus(`已載入 ${updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`, 'saved');
    toast(sameSource ? '雲端佈局及命名版本已載入。' : '雲端佈局已載入；目前 CAD 圖紙不同，請核對建築線。', sameSource ? 'success' : 'warning');
    return true;
  } catch (error) {
    console.error(error);
    setSyncStatus('載入失敗', 'error');
    toast(`雲端載入失敗：${error.message}`, 'error');
    return false;
  }
}

function readNamedVersions() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(NAMED_VERSIONS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('Unable to read named project versions', error);
    return {};
  }
}

function writeNamedVersions(versions, { sync = true } = {}) {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(NAMED_VERSIONS_KEY, JSON.stringify(versions));
    if (sync && typeof uploadSync === 'function') {
      const queue = typeof queueMicrotask === 'function' ? queueMicrotask : (callback) => setTimeout(callback, 0);
      queue(() => { void uploadSync({ quiet: true }); });
    }
    return true;
  } catch (error) {
    console.warn('Unable to write named project versions', error);
    return false;
  }
}

function namedVersionsForCurrentSource() {
  const versions = readNamedVersions();
  const sourceKey = String(state.sourceFileName || 'untitled-cad');
  return Array.isArray(versions[sourceKey]) ? versions[sourceKey].filter((item) => item?.project) : [];
}

function selectedNamedVersion() {
  const versionId = dom.savedVersionSelect?.value || '';
  return namedVersionsForCurrentSource().find((item) => item.id === versionId) || null;
}

function renderNamedVersions() {
  if (!dom.savedVersionSelect || !dom.versionStatus) return;
  const selectedId = dom.savedVersionSelect.value || '';
  const versions = namedVersionsForCurrentSource().sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  dom.savedVersionSelect.innerHTML = [
    '<option value="">選擇已保存版本</option>',
    ...versions.map((item) => {
      const savedAt = item.savedAt ? new Date(item.savedAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${savedAt ? ` · ${escapeHtml(savedAt)}` : ''}</option>`;
    })
  ].join('');
  if (versions.some((item) => item.id === selectedId)) dom.savedVersionSelect.value = selectedId;
  const hasSelection = Boolean(selectedNamedVersion());
  dom.versionStatus.textContent = `${versions.length} 個已保存版本`;
  if (dom.loadNamedVersionButton) dom.loadNamedVersionButton.disabled = !hasSelection;
  if (dom.deleteNamedVersionButton) dom.deleteNamedVersionButton.disabled = !hasSelection;
}

function saveNamedVersion() {
  if (typeof localStorage === 'undefined') return toast('此瀏覽器不支援本機版本保存。', 'error');
  const defaultName = `版本 ${new Date().toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  const name = window.prompt('請輸入版本名稱', defaultName)?.trim();
  if (!name) return;
  const allVersions = readNamedVersions();
  const sourceKey = String(state.sourceFileName || 'untitled-cad');
  const sourceVersions = Array.isArray(allVersions[sourceKey]) ? allVersions[sourceKey] : [];
  const existing = sourceVersions.find((item) => String(item.name || '').toLowerCase() === name.toLowerCase());
  if (existing && !window.confirm(`版本「${name}」已存在，要覆蓋嗎？`)) return;
  const item = {
    id: existing?.id || stableId('version'),
    name,
    savedAt: new Date().toISOString(),
    sourceFileName: state.sourceFileName,
    sourceRegionCount: currentSourceRegionCount(),
    project: snapshotProject()
  };
  allVersions[sourceKey] = existing
    ? sourceVersions.map((version) => version.id === existing.id ? item : version)
    : [...sourceVersions, item];
  if (!writeNamedVersions(allVersions)) return toast('版本保存失敗，請檢查瀏覽器儲存空間。', 'error');
  renderNamedVersions();
  dom.savedVersionSelect.value = item.id;
  renderNamedVersions();
  toast(`已保存命名版本「${name}」。`, 'success');
}

function loadNamedVersion() {
  const item = selectedNamedVersion();
  if (!item) return toast('請先選擇要載入的版本。', 'warning');
  if (String(item.sourceFileName || '') !== String(state.sourceFileName || '') || Number(item.sourceRegionCount) !== currentSourceRegionCount()) {
    return toast('此版本與目前圖紙的區域數量不一致，請先開啟對應 CAD 圖紙。', 'warning');
  }
  try {
    pushHistory();
    restoreProject(item.project, true);
    dom.savedVersionSelect.value = item.id;
    renderNamedVersions();
    dom.savedVersionSelect.value = item.id;
    toast(`已載入版本「${item.name}」。`, 'success');
  } catch (error) {
    console.error(error);
    toast('版本資料無法載入。', 'error');
  }
}

function deleteNamedVersion() {
  const item = selectedNamedVersion();
  if (!item) return toast('請先選擇要刪除的版本。', 'warning');
  if (!window.confirm(`刪除命名版本「${item.name}」？`)) return;
  const allVersions = readNamedVersions();
  const sourceKey = String(state.sourceFileName || 'untitled-cad');
  allVersions[sourceKey] = (allVersions[sourceKey] || []).filter((version) => version.id !== item.id);
  if (!writeNamedVersions(allVersions)) return toast('版本刪除失敗。', 'error');
  renderNamedVersions();
  toast(`已刪除版本「${item.name}」。`, 'success');
}

function updateAutosaveStatus(message, type = '') {
  if (!dom.autosaveStatus) return;
  dom.autosaveStatus.textContent = message;
  dom.autosaveStatus.className = `autosave-status ${type}`.trim();
}

function saveAutoProject() {
  if (typeof localStorage === 'undefined') {
    updateAutosaveStatus('此瀏覽器不支援自動保存', 'error');
    return false;
  }
  try {
    const project = snapshotProject();
    project.savedAt = new Date().toISOString();
    localStorage.setItem(AUTO_PROJECT_KEY, JSON.stringify(project));
    const savedAt = new Date(project.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    updateAutosaveStatus(`已自動保存 ${savedAt}`, 'saved');
    void persistActiveProject({ includeSource: false, sync: true });
    return true;
  } catch (error) {
    console.warn('Unable to save automatic project snapshot', error);
    updateAutosaveStatus('本機保存空間不足', 'error');
    return false;
  }
}

function scheduleAutoSave() {
  if (typeof localStorage === 'undefined') return;
  clearTimeout(state.autoSaveTimer);
  updateAutosaveStatus('保存中…');
  state.autoSaveTimer = setTimeout(saveAutoProject, 360);
}

function restoreAutoProjectIfCompatible(fileName) {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(AUTO_PROJECT_KEY);
    if (!raw) return false;
    const project = JSON.parse(raw);
    if (project?.projectType !== 'roof-tile-layout' || Number(project.version || 0) < 4) return false;
    if (String(project.sourceFileName || '') !== String(fileName || '')) return false;
    if (Number(project.sourceRegionCount) !== currentSourceRegionCount()) return false;
    restoreProject(project, true);
    const savedAt = project.savedAt ? new Date(project.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    updateAutosaveStatus(savedAt ? `已恢復保存 ${savedAt}` : '已恢復本機設定', 'saved');
    return true;
  } catch (error) {
    console.warn('Unable to restore automatic project snapshot', error);
    updateAutosaveStatus('本機設定讀取失敗', 'error');
    return false;
  }
}

function pushHistory() {
  try {
    state.history.push(snapshotProject());
    if (state.history.length > 30) state.history.shift();
    dom.undoButton.disabled = false;
  } catch (error) {
    console.warn('Unable to save undo snapshot', error);
  }
}

function normalizeControl(target = {}) {
  return {
    ...target,
    originX: Number(target.originX || 0),
    originY: Number(target.originY || 0),
    offsetX: Number(target.offsetX || 0),
    offsetY: Number(target.offsetY || 0),
    up: Number(target.up || 0),
    down: Number(target.down || 0),
    left: Number(target.left || 0),
    right: Number(target.right || 0),
    originAlignX: Number(target.originAlignX || 0),
    originAlignY: Number(target.originAlignY || 0),
    staggerPhaseX: Number(target.staggerPhaseX || 0),
    staggerPhaseY: Number(target.staggerPhaseY || 0)
  };
}

function restoreProject(project, keepCad = true) {
  if (!project || project.projectType !== 'roof-tile-layout') throw new Error('不是屋面瓷磚排布設定檔。');
  const oldSettings = project.settings || {};
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...oldSettings,
    dimensionDigits: 0,
    tileLong: Math.max(1, integerMm(oldSettings.tileLong ?? oldSettings.tileWidth, DEFAULT_SETTINGS.tileLong)),
    tileShort: Math.max(1, integerMm(oldSettings.tileShort ?? oldSettings.tileHeight, DEFAULT_SETTINGS.tileShort)),
    jointX: Math.max(0, integerMm(oldSettings.jointX, DEFAULT_SETTINGS.jointX)),
    jointY: Math.max(0, integerMm(oldSettings.jointY, DEFAULT_SETTINGS.jointY)),
    staggerOffset: Math.max(0, integerMm(oldSettings.staggerOffset, DEFAULT_SETTINGS.staggerOffset)),
    minCut: Math.max(0, integerMm(oldSettings.minCut, DEFAULT_SETTINGS.minCut))
  };
  state.regions = (project.regions || []).map((region) => {
    const polygon = cleanPolygon(region.polygon || []);
    return {
      ...normalizeControl(region),
      polygon,
      holes: (region.holes || []).map((hole) => cleanPolygon(hole)),
      bbox: bboxOfPoints(polygon),
      rotation: normalizeRotation(region.rotation),
      enabled: region.enabled !== false
    };
  });
  state.sourceRegionCount = Number(project.sourceRegionCount || state.regions.length || 0);
  state.sourceSyncId = String(project.sourceSyncId || '');
  state.sourceMode = project.sourceMode || (state.cad ? 'hatch' : 'cloud');
  state.hatchObjectCount = Number(project.hatchObjectCount ?? state.hatchObjectCount ?? 0);
  state.hatchHoleCount = Number(project.hatchHoleCount ?? state.hatchHoleCount ?? 0);
  state.removedOverlapRegions = Number(project.removedOverlapRegions ?? state.removedOverlapRegions ?? 0);
  state.baseRegionCount = Number(project.baseRegionCount ?? state.baseRegionCount ?? 0);
  state.splitRegionCount = Number(project.splitRegionCount ?? state.splitRegionCount ?? state.regions.length);
  state.exactCount = Number(project.exactCount ?? state.exactCount ?? state.regions.length);
  state.removedHatchKeys = new Set(Array.isArray(project.removedHatchKeys) ? project.removedHatchKeys.map(String) : []);
  state.groups = (project.groups || []).map((group) => ({
    ...normalizeControl(group),
    unifiedOrigin: group.unifiedOrigin !== false,
    carryAcross: group.carryAcross !== false,
    anchorRegionId: group.anchorRegionId || null
  }));
  for (const group of state.groups) {
    const members = state.regions.filter((region) => region.groupId === group.id);
    if (members.length > 1) { group.unifiedOrigin = true; group.carryAcross = true; }
    if (!members.some((region) => region.id === group.anchorRegionId)) group.anchorRegionId = members[0]?.id || null;
  }
  state.bands = (project.bands || []).map((band) => ({ ...band, enabled: band.enabled !== false }));
  state.detectedJointCount = Number(project.detectedJointCount ?? state.detectedJointCount ?? state.bands.filter((band) => band.source === 'dxf-joint-hatch').length);
  state.layerMapping = { ...state.layerMapping, ...(project.layerMapping || {}) };
  state.sourceFileName = project.sourceFileName || state.sourceFileName;
  if (project.cad) state.cad = structuredClone(project.cad);
  if (typeof project.sourceDxfText === 'string') state.sourceDxfText = project.sourceDxfText;
  else if (!keepCad && !project.cad) state.sourceDxfText = '';
  state.activeGroupId = project.activeGroupId || state.groups[0]?.id || null;
  state.activeRegionId = project.activeRegionId || state.regions[0]?.id || null;
  state.selection = new Set(state.activeRegionId ? [state.activeRegionId] : []);
  state.touchMergeMode = false;
  if (!keepCad && !project.cad) state.cad = null;
  syncSettingsInputs();
  renderAllControls();
  scheduleLayout();
  fitView();
}

function createGroup(id, name, originX, originY, color) {
  return {
    id, name,
    unifiedOrigin: true,
    carryAcross: true,
    originX, originY,
    offsetX: 0, offsetY: 0,
    up: 0, down: 0, left: 0, right: 0,
    originAlignX: 0, originAlignY: 0,
    staggerPhaseX: 0, staggerPhaseY: 0,
    anchorRegionId: null,
    color
  };
}

function createQARegion(summary, index, qa) {
  const rotation = normalizeRotation(summary.rotation);
  const groupId = rotation === 90 ? 'group-v' : 'group-h';
  const polygon = rectanglePolygon(summary.min_x, summary.min_y, summary.max_x, summary.max_y);
  return {
    id: `region-${String(index + 1).padStart(2, '0')}`,
    name: `區域 ${String(index + 1).padStart(2, '0')}`,
    polygon,
    bbox: bboxOfPoints(polygon),
    rotation,
    groupId,
    originX: rotation === 90 ? qa.v_ref_x : qa.h_ref_x,
    originY: rotation === 90 ? qa.v_ref_y : qa.h_ref_y,
    offsetX: 0, offsetY: 0, up: 0, down: 0, left: 0, right: 0,
    enabled: true,
    approximate: true,
    sourceVertices: summary.vertices,
    qaSummary: summary
  };
}

function applyQA(qa) {
  state.qa = qa;
  state.sourceDxfText = '';
  state.sourceRegionCount = qa.region_summary.length;
  state.removedHatchKeys = new Set();
  state.regions = qa.region_summary.map((summary, index) => createQARegion(summary, index, qa));
  state.groups = [
    createGroup('group-h', '長邊沿 X 排布', qa.h_ref_x, qa.h_ref_y, '#0b6bcb'),
    createGroup('group-v', '長邊沿 Y 排布', qa.v_ref_x, qa.v_ref_y, '#7a49a5')
  ];
  state.bands = [];
  state.layerMapping.region = qa.layer || 'ROOF_TILE_LAYOUT';
  state.activeRegionId = state.regions[0]?.id || null;
  state.activeGroupId = state.regions[0]?.groupId || state.groups[0]?.id || null;
  state.selection = new Set(state.activeRegionId ? [state.activeRegionId] : []);
  state.touchMergeMode = false;
  state.exactCount = 0;
  state.sourceMode = 'preview';
  setSourceBadge('QA 預覽', 'preview');
  setNotice('正在以 24 個 QA 外框預覽；內置 DXF 解析完成後會以精確封閉多段線替換。', 'warning');
  renderAllControls();
  scheduleLayout();
  fitView();
}

function syncSettingsInputs() {
  dom.tileLongInput.value = state.settings.tileLong;
  dom.tileShortInput.value = state.settings.tileShort;
  dom.jointXInput.value = state.settings.jointX;
  dom.jointYInput.value = state.settings.jointY;
  if (dom.staggerEnabledInput) dom.staggerEnabledInput.checked = state.settings.staggerEnabled !== false;
  if (dom.staggerOffsetInput) dom.staggerOffsetInput.value = state.settings.staggerOffset ?? Math.max(1, Number(state.settings.tileLong || 600) / 2);
  dom.minCutInput.value = state.settings.minCut;
  dom.dimensionDigitsInput.value = state.settings.dimensionDigits;
  dom.showFullTilesInput.checked = state.settings.showFullTiles;
  dom.showCutLabelsInput.checked = state.settings.showCutLabels;
  dom.showCadInput.checked = state.settings.showCad;
  dom.keepArchitectureInput.checked = state.settings.keepArchitectureOnTop !== false;
}

function readSettingsInputs() {
  state.settings.tileLong = Math.max(1, integerMm(dom.tileLongInput, 600));
  state.settings.tileShort = Math.max(1, integerMm(dom.tileShortInput, 300));
  state.settings.jointX = Math.max(0, integerMm(dom.jointXInput, 5));
  state.settings.jointY = Math.max(0, integerMm(dom.jointYInput, 5));
  state.settings.staggerEnabled = dom.staggerEnabledInput ? dom.staggerEnabledInput.checked : true;
  state.settings.staggerOffset = Math.max(0, integerMm(dom.staggerOffsetInput, Math.max(1, state.settings.tileLong / 2)));
  state.settings.minCut = Math.max(0, integerMm(dom.minCutInput, 100));
  // Project dimensions, offsets and exported labels are deliberately integer mm.
  state.settings.dimensionDigits = 0;
  state.settings.showFullTiles = dom.showFullTilesInput.checked;
  state.settings.showCutLabels = dom.showCutLabelsInput.checked;
  state.settings.showCad = dom.showCadInput.checked;
  state.settings.keepArchitectureOnTop = dom.keepArchitectureInput.checked;
  dom.tileLongInput.value = state.settings.tileLong;
  dom.tileShortInput.value = state.settings.tileShort;
  dom.jointXInput.value = state.settings.jointX;
  dom.jointYInput.value = state.settings.jointY;
  dom.staggerOffsetInput.value = state.settings.staggerOffset;
  dom.minCutInput.value = state.settings.minCut;
  renderGroupControls();
}

function updateSourceMetrics() {
  dom.sourceFileName.textContent = state.sourceFileName;
  const sourceFormat = state.cad?.format || (String(state.sourceFileName).toLowerCase().endsWith('.dxf') ? 'DXF' : 'DWG');
  dom.sourceIcon.textContent = sourceFormat;
  dom.regionCountMetric.textContent = state.regions.length.toLocaleString();
  dom.exactCountMetric.textContent = state.sourceMode === 'hatch'
    ? `${state.baseRegionCount}→${state.splitRegionCount}`
    : state.sourceMode === 'cad-pick'
      ? '待取區'
      : `${state.exactCount}/${state.regions.length}`;
  dom.horizontalCountMetric.textContent = state.regions.filter((region) => normalizeRotation(region.rotation) === 0).length.toLocaleString();
  dom.verticalCountMetric.textContent = state.regions.filter((region) => normalizeRotation(region.rotation) === 90).length.toLocaleString();
  const projectPrefix = state.projectName ? `Project：${state.projectName} · ` : '';
  dom.sourceSubtitle.textContent = state.sourceMode === 'hatch'
    ? `${projectPrefix}${state.sourceFileName} · HATCH 標定區域已載入`
    : state.sourceMode === 'exact'
      ? `${projectPrefix}${state.sourceFileName} · 精確多段線已載入`
      : state.sourceMode === 'cad-pick'
        ? `${projectPrefix}${state.sourceFileName} · CAD 閉合區域取區模式`
      : `${projectPrefix}${state.sourceFileName} · ${state.regions.length} 個最小區域`;
  const hasStoredHatchMetrics = state.sourceMode === 'hatch'
    && (state.hatchObjectCount || state.baseRegionCount || state.detectedJointCount || state.hatchHoleCount);
  if (state.cad || hasStoredHatchMetrics) {
    const blockNote = state.cad?.expandedInsertInstances ? ` · 展開 ${state.cad.expandedInsertInstances.toLocaleString()} 個圖塊實例` : '';
    dom.sourceDetail.textContent = state.sourceMode === 'hatch'
      ? `${state.hatchObjectCount} HATCH · ${state.baseRegionCount} 原區 → ${state.regions.length} 最小倉 · ${state.detectedJointCount} 條20mm縫 · ${state.hatchHoleCount} 孔洞 · ${state.layerMapping.region}`
      : `${state.cad.entities.length.toLocaleString()} 個可繪實體 · ${state.cad.layers.length} 圖層${blockNote}`;
  }
  else if (state.qa) dom.sourceDetail.textContent = `${state.qa.closed_source_polylines} 條封閉來源線 · QA 預覽`;
}

function renderRegionList() {
  dom.selectedRegionCount.textContent = `${state.selection.size} 已選`;
  dom.mergeRegionsButton.textContent = state.selection.size > 1 ? `合併所選（${state.selection.size}）` : '合併排布';
  dom.splitRegionsButton.textContent = state.selection.size ? `取消合併（${state.selection.size}）` : '取消合併';
  const manualCount = selectedRegions().filter((region) => region.manualCad === true).length;
  const hatchCount = selectedRegions().filter((region) => isRemovableHatchRegion(region)).length;
  if (dom.deleteRegionButton) {
    dom.deleteRegionButton.disabled = manualCount === 0;
    dom.deleteRegionButton.textContent = manualCount ? `刪除新增區域（${manualCount}）` : '刪除新增區域';
    dom.deleteRegionButton.title = manualCount
      ? '只刪除用 CAD 取區／選閉合線新增的區域'
      : '先選取用 CAD 取區／選閉合線新增的區域';
  }
  if (dom.removeHatchButton) {
    dom.removeHatchButton.disabled = hatchCount === 0;
    dom.removeHatchButton.textContent = hatchCount ? `移除 HATCH（${hatchCount}）` : '移除 HATCH 區域';
    dom.removeHatchButton.title = hatchCount
      ? '移除選取的原始 HATCH 區域；可用 Ctrl+Z 復原'
      : '先選取要移除的原始 HATCH 區域';
  }
  updateSelectionHint();
}

function renderGroupControls() {
  const group = activeGroup();
  if (group && state.activeGroupId !== group.id) state.activeGroupId = group.id;
  dom.activeGroupSelect.innerHTML = state.groups.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.activeGroupId ? 'selected' : ''}>${escapeHtml(item.name)} (${groupMembers(item.id).length})</option>`).join('');
  const memberCount = group ? groupMembers(group.id).length : 0;
  dom.activeGroupBadge.textContent = group ? `${memberCount} 區域` : '—';
  if (!group) return;
  const persistentMerged = memberCount > 1;
  if (persistentMerged) { group.unifiedOrigin = true; group.carryAcross = true; }
  dom.unifiedOriginInput.checked = group.unifiedOrigin !== false;
  dom.carryAcrossInput.checked = group.carryAcross !== false;
  dom.unifiedOriginInput.disabled = persistentMerged;
  dom.carryAcrossInput.disabled = persistentMerged;
  dom.unifiedOriginInput.title = persistentMerged ? '合併組固定共用起點；請使用「獨立排布」解除。' : '';
  dom.carryAcrossInput.title = persistentMerged ? '合併組固定跨空隙續排；請使用「獨立排布」解除。' : '';
  const region = activeRegion();
  const target = group.unifiedOrigin !== false ? group : region;
  dom.originXInput.value = target?.originX ?? '';
  dom.originYInput.value = target?.originY ?? '';
  dom.nudgeUpInput.value = target?.up ?? 0;
  dom.nudgeDownInput.value = target?.down ?? 0;
  dom.nudgeLeftInput.value = target?.left ?? 0;
  dom.nudgeRightInput.value = target?.right ?? 0;

  const regions = selectedRegions();
  const rotations = new Set(regions.map((item) => normalizeRotation(item.rotation)));
  const selectedRotation = rotations.size > 1 ? 'mixed' : String([...rotations][0] ?? normalizeRotation(region?.rotation));
  dom.selectedOrientationInput.value = selectedRotation;
  const previewRotation = selectedRotation === 'mixed' ? normalizeRotation(region?.rotation) : Number(selectedRotation);
  const nominal = nominalTileSize(state.settings, previewRotation);
  dom.orientationPreview.classList.toggle('long-y', previewRotation === 90);
  dom.orientationPreview.classList.toggle('long-x', previewRotation !== 90);
  dom.orientationPreviewTitle.textContent = selectedRotation === 'mixed' ? '所選區域為混合方向' : rotationLabel(previewRotation);
  dom.orientationPreviewText.textContent = selectedRotation === 'mixed'
    ? `目前活動區域：${formatMm(nominal.width, 0)} × ${formatMm(nominal.height, 0)} mm`
    : `X ${formatMm(nominal.width, 0)} × Y ${formatMm(nominal.height, 0)} mm`;
  dom.activeGroupBadge.title = group.unifiedOrigin === false && groupMembers(group.id).length > 1
    ? '此組已設為每區域獨立起點；目前編輯最後點選區域。' : '';
}

function renderBandList() {
  dom.bandList.innerHTML = state.bands.length ? state.bands.map((band) => {
    const width = band.axis === 'x' ? band.maxX - band.minX : band.maxY - band.minY;
    const locked = band.source === 'dxf-joint-hatch' || band.source === 'manual-region-cut';
    const source = band.source === 'dxf-joint-hatch'
      ? `${escapeHtml(band.sourceLayer || '')} · ${escapeHtml(band.sourcePattern || '')}`
      : band.source === 'manual-region-cut' ? '手動切倉 · 使用復原撤銷'
      : band.global ? '所有排布組' : escapeHtml(groupById(band.groupId)?.name || '目前組');
    return `<div class="band-row" data-band-id="${escapeHtml(band.id)}">
      <input type="checkbox" ${band.enabled !== false ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="啟用分界" />
      <div><strong>${escapeHtml(band.type || '分界帶')}</strong><span>${band.axis === 'x' ? '垂直帶' : '水平帶'} · ${formatMm(width, 0)} mm · ${source}</span></div>
      ${band.source === 'dxf-joint-hatch' ? '<span class="locked-band" title="來自DXF標定HATCH">DXF</span>' : band.source === 'manual-region-cut' ? '<span class="locked-band" title="已切割區域，請用復原撤銷">手動</span>' : '<button class="band-delete" title="刪除">×</button>'}
    </div>`;
  }).join('') : '<div class="band-empty">沒有已標定伸縮縫。可用「畫分界」手動加入。</div>';
}


function renderWarnings() {
  dom.warningList.innerHTML = (state.layout.warnings || []).slice(0, 6).map((warning) => `<div class="warning-item">${escapeHtml(warning)}</div>`).join('');
}

function renderMetrics() {
  const stats = state.layout.stats || {};
  dom.conceptualTileMetric.textContent = Number(stats.conceptualTiles || 0).toLocaleString();
  dom.fullTileMetric.textContent = Number(stats.fullTiles || 0).toLocaleString();
  dom.cutPieceMetric.textContent = Number(stats.cutPieces || 0).toLocaleString();
  dom.continuationMetric.textContent = Number(stats.continuationTiles || 0).toLocaleString();
  dom.minPieceMetric.textContent = stats.minPiece == null ? '—' : `${formatMm(stats.minPiece, 0)} mm`;
  dom.smallPieceMetric.textContent = Number(stats.smallCutPieces || 0).toLocaleString();
  const virtualGapCount = (state.layout.virtualGaps || []).length;
  dom.stageStatusText.textContent = `${state.regions.filter((region) => region.enabled !== false).length} 最小倉 · ${state.groups.length} 排布組 · ${state.detectedJointCount} 條標定縫 · ${virtualGapCount} 條隱藏續排關係 · ${Number(stats.candidateCells || 0).toLocaleString()} 候選格`;
}

function shortTileId(tileId) {
  const parts = String(tileId).split(':');
  return parts.length >= 4 ? `${parts.at(-2)},${parts.at(-1)}` : tileId;
}

function renderCutTable() {
  const selectedOnly = dom.cutSelectedOnlyInput.checked;
  const smallOnly = dom.cutSmallOnlyInput.checked;
  const search = dom.cutSearchInput.value.trim().toLowerCase();
  const pieces = (state.layout.pieces || [])
    .filter((piece) => piece.cut)
    .filter((piece) => !selectedOnly || state.selection.has(piece.regionId))
    .filter((piece) => !smallOnly || piece.smallCut)
    .filter((piece) => !search || `${piece.regionName} ${piece.tileId} ${piece.id}`.toLowerCase().includes(search))
    .sort((a, b) => Number(b.smallCut) - Number(a.smallCut) || Number(b.continuation) - Number(a.continuation) || a.regionName.localeCompare(b.regionName))
    .slice(0, 700);
  const digits = state.settings.dimensionDigits;
  dom.cutTableBody.innerHTML = pieces.map((piece) => {
    let statusClass = 'normal';
    let status = '邊界切磚';
    if (piece.smallCut) { statusClass = 'small'; status = '小尺寸'; }
    else if (piece.continuation) { statusClass = 'carry'; status = '跨縫續用'; }
    else if (!piece.rectangular) { statusClass = 'irregular'; status = '異形核對'; }
    return `<tr data-piece-id="${escapeHtml(piece.id)}" data-region-id="${escapeHtml(piece.regionId)}">
      <td>${escapeHtml(piece.regionName)}<br><small>${rotationLabel(piece.rotation, true)}</small></td>
      <td>${escapeHtml(shortTileId(piece.tileId))}<br><small>片 ${piece.fragmentIndex + 1}</small></td>
      <td>${formatMm(piece.width, digits)} × ${formatMm(piece.height, digits)}${piece.rectangular ? '' : '*'}<br><small>最小 ${formatMm(piece.minimumDimension ?? Math.min(piece.width, piece.height), digits)}</small></td>
      <td><span class="cut-status ${statusClass}">${status}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="text-align:center;color:#647180;padding:14px">沒有符合條件的非整磚</td></tr>';
}

function renderLayerDialog() {
  const layers = state.cad?.layers || [];
  const hatchLayers = layers.filter((layer) => Number(layer.hatches || 0) > 0);
  const patternsByLayer = new Map();
  for (const entity of state.cad?.entities || []) {
    if (entity.type !== 'HATCH') continue;
    const patterns = patternsByLayer.get(entity.layer) || new Set();
    if (entity.patternName) patterns.add(entity.patternName);
    patternsByLayer.set(entity.layer, patterns);
  }
  const description = (layer) => {
    const patterns = [...(patternsByLayer.get(layer.name) || [])].join(', ') || '未命名圖案';
    return `${layer.hatches} HATCH · ${patterns}`;
  };
  const options = hatchLayers.map((layer) => `<option value="${escapeHtml(layer.name)}">${escapeHtml(layer.name)} · ${escapeHtml(description(layer))}</option>`).join('');
  dom.regionLayerSelect.innerHTML = options || '<option value="">尚未找到 HATCH 圖層</option>';
  dom.regionLayerSelect.value = state.layerMapping.region || hatchLayers[0]?.name || '';
  dom.layerSummary.innerHTML = hatchLayers.map((layer) => `<div class="layer-summary-row"><span>${escapeHtml(layer.name)}</span><span>${layer.hatches} HATCH</span><span>${escapeHtml([...(patternsByLayer.get(layer.name) || [])].join(', ') || '—')}</span><span>${layer.entities} 實體</span></div>`).join('') || '<div class="band-empty">尚未解析到 HATCH</div>';
}

function renderAllControls() {
  updateSourceMetrics();
  renderProjectControls();
  renderNamedVersions();
  renderRegionList();
  renderGroupControls();
  renderBandList();
  renderMetrics();
  renderWarnings();
  renderCutTable();
  requestRender();
}

function calculateLayout() {
  dom.calculationBadge.textContent = '計算中';
  dom.calculationBadge.className = 'calculation-badge busy';
  try {
    state.layout = generateLayout({ settings: state.settings, regions: state.regions, groups: state.groups, bands: state.bands });
    dom.calculationBadge.textContent = '已即時更新';
    dom.calculationBadge.className = 'calculation-badge done';
    renderMetrics();
    renderWarnings();
    renderCutTable();
    requestRender();
  } catch (error) {
    console.error(error);
    dom.calculationBadge.textContent = '計算錯誤';
    dom.calculationBadge.className = 'calculation-badge error';
    state.layout.warnings = [error.message];
    renderWarnings();
  }
}

function scheduleLayout() {
  clearTimeout(state.calculationTimer);
  dom.calculationBadge.textContent = '等候重算';
  dom.calculationBadge.className = 'calculation-badge busy';
  state.calculationTimer = setTimeout(calculateLayout, 55);
  scheduleAutoSave();
}

function resizeCanvas() {
  const rect = dom.canvasFrame.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (dom.layoutCanvas.width !== Math.round(width * dpr) || dom.layoutCanvas.height !== Math.round(height * dpr)) {
    dom.layoutCanvas.width = Math.round(width * dpr);
    dom.layoutCanvas.height = Math.round(height * dpr);
  }
  return { width, height, dpr };
}

function worldToScreen(point, metrics = resizeCanvas()) {
  return {
    x: (point.x - state.view.centerX) * state.view.scale + metrics.width / 2,
    y: (state.view.centerY - point.y) * state.view.scale + metrics.height / 2
  };
}

function screenToWorld(point, metrics = resizeCanvas()) {
  return {
    x: (point.x - metrics.width / 2) / state.view.scale + state.view.centerX,
    y: state.view.centerY - (point.y - metrics.height / 2) / state.view.scale
  };
}

function visibleWorldBBox(metrics = resizeCanvas()) {
  const topLeft = screenToWorld({ x: 0, y: 0 }, metrics);
  const bottomRight = screenToWorld({ x: metrics.width, y: metrics.height }, metrics);
  return { minX: topLeft.x, maxX: bottomRight.x, minY: bottomRight.y, maxY: topLeft.y, width: bottomRight.x - topLeft.x, height: topLeft.y - bottomRight.y };
}

function niceStep(value) {
  const exponent = Math.floor(Math.log10(Math.max(value, 1e-9)));
  const fraction = value / 10 ** exponent;
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  return nice * 10 ** exponent;
}

function drawGrid(ctx, metrics, visible) {
  const step = niceStep(95 / state.view.scale);
  const startX = Math.floor(visible.minX / step) * step;
  const startY = Math.floor(visible.minY / step) * step;
  ctx.save();
  ctx.strokeStyle = '#dfe4e9';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= visible.maxX; x += step) {
    const screen = worldToScreen({ x, y: 0 }, metrics);
    ctx.moveTo(screen.x, 0); ctx.lineTo(screen.x, metrics.height);
  }
  for (let y = startY; y <= visible.maxY; y += step) {
    const screen = worldToScreen({ x: 0, y }, metrics);
    ctx.moveTo(0, screen.y); ctx.lineTo(metrics.width, screen.y);
  }
  ctx.stroke();
  ctx.restore();
}

function pathPolygon(ctx, polygon, metrics) {
  if (!polygon?.length) return;
  const first = worldToScreen(polygon[0], metrics);
  ctx.moveTo(first.x, first.y);
  for (let index = 1; index < polygon.length; index += 1) {
    const point = worldToScreen(polygon[index], metrics);
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
}

function pathRegion(ctx, region, metrics) {
  pathPolygon(ctx, region.polygon, metrics);
  for (const hole of region.holes || []) pathPolygon(ctx, hole, metrics);
}

function pointInRegion(point, region) {
  if (!pointInBBox(point, region.bbox, 0) || !pointInPolygon(point, region.polygon)) return false;
  return !(region.holes || []).some((hole) => pointInPolygon(point, hole));
}

function entityBBox(entity) {
  if (!entity._bbox) entity._bbox = bboxOfPoints(entity.points || []);
  return entity._bbox;
}

function cadClosedCandidates(layerName = '') {
  const target = String(layerName || '').trim().toUpperCase();
  return (state.cad?.entities || [])
    .filter((entity) => {
      const points = entity.points || [];
      const endpointsClose = points.length > 2
        && Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y) <= 0.5;
      return (entity.closed || /^(CIRCLE|ELLIPSE)$/i.test(entity.type || '') || endpointsClose)
        && points.length >= 3;
    })
    .filter((entity) => !target || String(entity.layer || '').trim().toUpperCase() === target)
    .map((entity, sourceIndex) => {
      const points = cleanPolygon(entity.points || []);
      return {
        ...entity,
        sourceIndex,
        points,
        bbox: bboxOfPoints(points),
        area: absolutePolygonArea(points),
        centroid: polygonCentroid(points),
        holes: entity.type === 'HATCH'
          ? (entity.boundaryPaths || []).filter((path) => Number(path.flags || 0) & 8).map((path) => cleanPolygon(path.points || []))
          : []
      };
    })
    .filter((entity) => entity.area > 1);
}

function normalizedLayerName(name) {
  return String(name || '0').trim().toUpperCase();
}

function mappedLayoutLayerNames() {
  return new Set([
    state.layerMapping.region,
    state.layerMapping.joint,
    state.layerMapping.channel
  ].filter(Boolean).map(normalizedLayerName));
}



function isLayoutRoleEntity(entity, roleLayers = mappedLayoutLayerNames()) {
  const layer = normalizedLayerName(entity.layer);
  if (entity.type === 'HATCH') return true;
  if (roleLayers.has(layer)) return true;
  return /(^|[^A-Z0-9])(ROOF[_ -]*TILE[_ -]*LAYOUT|TILE[_ -]*LAYOUT|PAVER[_ -]*LAYOUT)([^A-Z0-9]|$)/i.test(layer);
}

function traceCadEntity(ctx, entity, metrics) {
  const points = entity.points || [];
  if (points.length < 2) return false;
  ctx.beginPath();
  const first = worldToScreen(points[0], metrics);
  ctx.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = worldToScreen(points[index], metrics);
    ctx.lineTo(point.x, point.y);
  }
  if (entity.closed) ctx.closePath();
  return true;
}

function drawCadBackground(ctx, metrics, visible) {
  if (!state.settings.showCad || !state.cad) return;
  const roleLayers = mappedLayoutLayerNames();
  ctx.save();
  ctx.strokeStyle = 'rgba(74, 91, 108, .16)';
  ctx.lineWidth = .65;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let drawn = 0;
  const maxEntities = 16000;
  for (const entity of state.cad.entities) {
    if (drawn >= maxEntities) break;
    if (isLayoutRoleEntity(entity, roleLayers)) continue;
    if (!bboxesIntersect(entityBBox(entity), visible)) continue;
    if (!traceCadEntity(ctx, entity, metrics)) continue;
    ctx.stroke();
    drawn += 1;
  }
  ctx.restore();
}

function drawArchitectureOverlay(ctx, metrics, visible) {
  if (!state.settings.showCad || !state.settings.keepArchitectureOnTop || !state.cad) return;
  const roleLayers = mappedLayoutLayerNames();
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let drawn = 0;
  const maxEntities = 22000;
  for (const entity of state.cad.entities) {
    if (drawn >= maxEntities) break;
    if (isLayoutRoleEntity(entity, roleLayers)) continue;
    if (!bboxesIntersect(entityBBox(entity), visible)) continue;
    if (!traceCadEntity(ctx, entity, metrics)) continue;
    ctx.strokeStyle = 'rgba(255, 255, 255, .93)';
    ctx.lineWidth = 2.35;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(31, 45, 58, .94)';
    ctx.lineWidth = .82;
    ctx.stroke();
    drawn += 1;
  }
  ctx.restore();
}

function drawBands(ctx, metrics, visible) {
  ctx.save();
  for (const band of state.bands) {
    if (band.enabled === false || band.visible === false || !bboxesIntersect(band, visible)) continue;
    const topLeft = worldToScreen({ x: band.minX, y: band.maxY }, metrics);
    const bottomRight = worldToScreen({ x: band.maxX, y: band.minY }, metrics);
    let x = topLeft.x;
    let y = topLeft.y;
    let width = bottomRight.x - topLeft.x;
    let height = bottomRight.y - topLeft.y;
    // Keep a true 20 mm band unmistakable at overview scale without changing
    // its model coordinates or DXF export width.
    if (band.axis === 'x' && Math.abs(width) < 3) { x += width / 2 - 1.5; width = 3; }
    if (band.axis === 'y' && Math.abs(height) < 3) { y += height / 2 - 1.5; height = 3; }
    const isChannel = /渠|CHANNEL|DRAIN/i.test(band.type || '');
    ctx.fillStyle = isChannel ? 'rgba(185, 198, 211, .96)' : 'rgba(226, 29, 99, .96)';
    ctx.strokeStyle = isChannel ? '#52687a' : '#8f1645';
    ctx.lineWidth = 1.2;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    if (Math.max(Math.abs(width), Math.abs(height)) > 90) {
      ctx.fillStyle = isChannel ? '#1f2d3a' : '#ffffff';
      ctx.font = '700 9px Segoe UI, Microsoft JhengHei, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const physicalWidth = band.axis === 'x' ? band.maxX - band.minX : band.maxY - band.minY;
      ctx.fillText(`${formatMm(physicalWidth, 0)}mm`, x + width / 2, y + height / 2);
    }
  }
  if (state.interaction.bandPreview) {
    const band = state.interaction.bandPreview;
    const a = worldToScreen({ x: band.minX, y: band.maxY }, metrics);
    const b = worldToScreen({ x: band.maxX, y: band.minY }, metrics);
    ctx.fillStyle = 'rgba(11, 107, 203, .18)';
    ctx.strokeStyle = '#0b6bcb'; ctx.lineWidth = 2; ctx.setLineDash([7, 4]);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
  }
  ctx.restore();
}


function drawTileHatch(ctx, piece, metrics, color = 'rgba(44, 79, 106, .22)', spacing = 10) {
  const topLeft = worldToScreen({ x: piece.bbox.minX, y: piece.bbox.maxY }, metrics);
  const bottomRight = worldToScreen({ x: piece.bbox.maxX, y: piece.bbox.minY }, metrics);
  const minX = Math.min(topLeft.x, bottomRight.x) - 24;
  const maxX = Math.max(topLeft.x, bottomRight.x) + 24;
  const minY = Math.min(topLeft.y, bottomRight.y) - 24;
  const maxY = Math.max(topLeft.y, bottomRight.y) + 24;
  ctx.save();
  ctx.beginPath();
  pathPolygon(ctx, piece.polygon, metrics);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  const span = maxY - minY;
  for (let x = minX - span; x <= maxX + span; x += spacing) {
    ctx.moveTo(x, maxY);
    ctx.lineTo(x + span, minY);
  }
  ctx.stroke();
  ctx.restore();
}

function drawSmallPieceHatch(ctx, piece, metrics) {
  drawTileHatch(ctx, piece, metrics, 'rgba(137, 18, 35, .86)', 8);
}

function drawTilePieces(ctx, metrics, visible) {
  const labels = [];
  const labelScaleThreshold = Math.min(state.settings.tileLong, state.settings.tileShort) * state.view.scale > 44;
  let labelCount = 0;
  for (const piece of state.layout.pieces || []) {
    if (!bboxesIntersect(piece.bbox, visible)) continue;
    if (!piece.cut && !state.settings.showFullTiles) continue;
    ctx.beginPath(); pathPolygon(ctx, piece.polygon, metrics);
    if (!piece.cut) { ctx.fillStyle = 'rgba(67, 139, 190, .12)'; ctx.strokeStyle = 'rgba(45, 112, 161, .42)'; }
    else if (piece.smallCut) { ctx.fillStyle = 'rgba(211, 54, 70, .44)'; ctx.strokeStyle = 'rgba(166, 28, 41, .94)'; }
    else if (piece.continuation) { ctx.fillStyle = 'rgba(223, 110, 32, .39)'; ctx.strokeStyle = 'rgba(174, 71, 8, .88)'; }
    else { ctx.fillStyle = 'rgba(239, 169, 68, .32)'; ctx.strokeStyle = 'rgba(176, 108, 15, .72)'; }
    ctx.lineWidth = piece.cut ? 1.15 : .65; ctx.fill(); ctx.stroke();
    drawTileHatch(ctx, piece, metrics, piece.cut ? 'rgba(103, 67, 21, .22)' : 'rgba(45, 112, 161, .20)', 11);
    if (piece.smallCut) drawSmallPieceHatch(ctx, piece, metrics);
    if (piece.cut && state.settings.showCutLabels && labelScaleThreshold && labelCount < 600) {
      labels.push({ piece, center: polygonCentroid(piece.polygon) });
      labelCount += 1;
    }
  }
  if (!labels.length) return;
  ctx.save();
  ctx.font = '600 9px Segoe UI, Microsoft JhengHei, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const { piece, center } of labels) {
    const screen = worldToScreen(center, metrics);
    const text = `${formatMm(piece.width, state.settings.dimensionDigits)}×${formatMm(piece.height, state.settings.dimensionDigits)}${piece.rectangular ? '' : '*'}${piece.continuation ? ' ↔' : ''}`;
    const width = ctx.measureText(text).width + 6;
    ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.fillRect(screen.x - width / 2, screen.y - 7, width, 14);
    ctx.fillStyle = piece.smallCut ? '#9f1f2d' : piece.continuation ? '#984907' : '#68430d';
    ctx.fillText(text, screen.x, screen.y);
  }
  ctx.restore();
}

function drawRegions(ctx, metrics, visible) {
  const names = [];
  for (const region of state.regions) {
    if (region.enabled === false || !bboxesIntersect(region.bbox, visible)) continue;
    const selected = state.selection.has(region.id);
    ctx.save(); ctx.beginPath(); pathRegion(ctx, region, metrics);
    if (selected) { ctx.fillStyle = 'rgba(11,107,203,.07)'; ctx.fill('evenodd'); }
    ctx.strokeStyle = selected ? '#075eae' : region.approximate ? '#a06a13' : '#273847';
    ctx.lineWidth = selected ? 2.4 : 1.25;
    ctx.setLineDash(region.approximate ? [7, 4] : []); ctx.stroke(); ctx.restore();
    const screen = worldToScreen(polygonCentroid(region.polygon), metrics);
    if (screen.x > -80 && screen.x < metrics.width + 80 && screen.y > -30 && screen.y < metrics.height + 30) names.push({ region, screen, selected });
  }
  ctx.save(); ctx.font = '700 10px Segoe UI, Microsoft JhengHei, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const { region, screen, selected } of names) {
    const group = groupById(region.groupId);
    const text = `${region.name} · ${rotationLabel(region.rotation, true)}`;
    const width = ctx.measureText(text).width + 8;
    ctx.fillStyle = selected ? 'rgba(11,107,203,.92)' : 'rgba(255,255,255,.86)'; ctx.fillRect(screen.x - width / 2, screen.y - 8, width, 16);
    ctx.fillStyle = selected ? '#fff' : group?.color || '#263746'; ctx.fillText(text, screen.x, screen.y);
  }
  ctx.restore();
}

function drawOrigins(ctx, metrics, visible) {
  ctx.save();
  for (const group of state.groups) {
    const members = groupMembers(group.id);
    if (!members.length) continue;
    let origin = null;
    if (group.unifiedOrigin !== false) origin = effectiveOrigin(members[0], group);
    else if (activeRegion()?.groupId === group.id) origin = effectiveOrigin(activeRegion(), group);
    if (!origin || !pointInBBox(origin, visible, 2000 / state.view.scale)) continue;
    const screen = worldToScreen(origin, metrics);
    ctx.strokeStyle = group.id === state.activeGroupId ? '#e12238' : (group.color || '#385a79');
    ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(screen.x, screen.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(screen.x - 13, screen.y); ctx.lineTo(screen.x + 13, screen.y); ctx.moveTo(screen.x, screen.y - 13); ctx.lineTo(screen.x, screen.y + 13); ctx.stroke();
  }
  ctx.restore();
}

function drawSnapPreview(ctx, metrics) {
  const snap = state.interaction.snapPreview;
  if (!snap || state.mode !== 'origin') return;
  const screen = worldToScreen(snap.point, metrics);
  ctx.save();
  ctx.strokeStyle = snap.type === '端點' ? '#e12238' : '#0b6bcb';
  ctx.fillStyle = 'rgba(255,255,255,.96)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(screen.x, screen.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(screen.x - 12, screen.y); ctx.lineTo(screen.x + 12, screen.y);
  ctx.moveTo(screen.x, screen.y - 12); ctx.lineTo(screen.x, screen.y + 12); ctx.stroke();
  const label = `${snap.type}${snap.source ? ` · ${snap.source}` : ''}`;
  ctx.font = '700 10px Segoe UI, Microsoft JhengHei, sans-serif';
  const width = ctx.measureText(label).width + 12;
  ctx.fillStyle = 'rgba(24,36,51,.92)';
  ctx.fillRect(screen.x + 12, screen.y - 25, width, 18);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(label, screen.x + 18, screen.y - 16);
  ctx.restore();
}

function drawSelectionBox(ctx, metrics) {
  const box = state.interaction.selectionBox;
  if (!box) return;
  const x = Math.min(box.start.x, box.end.x);
  const y = Math.min(box.start.y, box.end.y);
  const width = Math.abs(box.end.x - box.start.x);
  const height = Math.abs(box.end.y - box.start.y);
  if (width < 2 && height < 2) return;
  const crossing = box.end.x < box.start.x;
  ctx.save();
  ctx.fillStyle = crossing ? 'rgba(20, 145, 107, .13)' : 'rgba(11, 107, 203, .13)';
  ctx.strokeStyle = crossing ? '#14916b' : '#0b6bcb';
  ctx.lineWidth = 1.5;
  ctx.setLineDash(crossing ? [7, 4] : []);
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  const label = crossing ? '交叉選取' : '窗口選取';
  ctx.setLineDash([]);
  ctx.font = '700 10px Segoe UI, Microsoft JhengHei, sans-serif';
  const labelWidth = ctx.measureText(label).width + 12;
  ctx.fillStyle = crossing ? 'rgba(20, 145, 107, .94)' : 'rgba(11, 107, 203, .94)';
  ctx.fillRect(x, Math.max(0, y - 20), labelWidth, 18);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 6, Math.max(9, y - 11));
  ctx.restore();
}

function drawScaleBar(ctx, metrics) {
  const worldLength = niceStep(120 / state.view.scale);
  const pixels = worldLength * state.view.scale;
  const x = 18; const y = metrics.height - 20;
  ctx.save(); ctx.strokeStyle = '#243544'; ctx.fillStyle = '#243544'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + pixels, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.moveTo(x + pixels, y - 4); ctx.lineTo(x + pixels, y + 4); ctx.stroke();
  ctx.font = '600 9px Segoe UI, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(worldLength >= 1000 ? `${formatMm(worldLength / 1000, 1)} m` : `${formatMm(worldLength, 0)} mm`, x + pixels / 2, y - 7);
  ctx.restore();
}

function renderCanvas() {
  state.renderPending = false;
  const metrics = resizeCanvas();
  const ctx = dom.layoutCanvas.getContext('2d');
  const visible = visibleWorldBBox(metrics);
  ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  ctx.clearRect(0, 0, metrics.width, metrics.height);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, metrics.width, metrics.height);
  // 背景方格已關閉，避免干擾核對 CAD 建築線與排磚。
  drawCadBackground(ctx, metrics, visible);
  drawBands(ctx, metrics, visible);
  drawTilePieces(ctx, metrics, visible);
  drawArchitectureOverlay(ctx, metrics, visible);
  drawRegions(ctx, metrics, visible);
  drawOrigins(ctx, metrics, visible);
  drawSelectionBox(ctx, metrics);
  drawSnapPreview(ctx, metrics);
  drawScaleBar(ctx, metrics);
  const mmPerPixel = 1 / state.view.scale;
  dom.viewScaleLabel.textContent = `${formatMm(mmPerPixel, mmPerPixel < 1 ? 2 : 1)} mm/px`;
}

function requestRender() {
  if (state.renderPending) return;
  state.renderPending = true;
  requestAnimationFrame(renderCanvas);
}

function modelBBox(regions = state.regions) {
  const boxes = regions.filter((region) => region.enabled !== false).map((region) => region.bbox || bboxOfPoints(region.polygon));
  if (boxes.length) return unionBBoxes(boxes);
  const cadBoxes = (state.cad?.entities || []).filter((entity) => entity.points?.length >= 2).map((entity) => entityBBox(entity));
  return unionBBoxes(cadBoxes);
}

function fitView(regions = state.regions) {
  const metrics = resizeCanvas();
  const bbox = modelBBox(regions);
  const padding = Math.max(1000, Math.max(bbox.width, bbox.height) * .05);
  const padded = expandBBox(bbox, padding);
  state.view.centerX = (padded.minX + padded.maxX) / 2;
  state.view.centerY = (padded.minY + padded.maxY) / 2;
  state.view.scale = Math.max(1e-5, Math.min(metrics.width / Math.max(1, padded.width), metrics.height / Math.max(1, padded.height)));
  requestRender();
}

function zoomToSelection() {
  const selected = selectedRegions();
  if (!selected.length) return toast('請先選擇一個或多個區域。', 'warning');
  fitView(selected);
}

function zoomToRegion(region) {
  if (region) fitView([region]);
}

function setMode(mode) {
  state.mode = mode;
  if (mode !== 'origin') state.interaction.snapPreview = null;
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  dom.layoutCanvas.className = `mode-${mode}`;
  const instructions = {
    select: '點選區域；左至右窗口選取，右至左交叉選取；Ctrl/Command 或 Shift 可加入。滾輪縮放，中鍵拖移。',
    pan: '按住左鍵拖移視圖；滾輪縮放。',
    origin: '在圖上點選目前排布組／區域的起點。',
    band: '沿伸縮縫或渠道長方向拖動；分界寬度按右側設定。',
    pickRegion: 'CAD 取區：點區域內部，或直接點閉合邊界；系統會加入最小閉合區域。'
  };
  instructions.pickBoundary = 'CAD 選閉合線：直接點擊閉合多段線、圓、橢圓或 HATCH 邊界。';
  dom.stageInstruction.textContent = instructions[mode] || '';
}


function distance2(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

function nearestPointOnSegment(point, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const length2 = vx * vx + vy * vy;
  if (length2 <= 1e-9) return { point: a, t: 0 };
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / length2));
  return { point: { x: a.x + vx * t, y: a.y + vy * t }, t };
}

function collectSnapPolylines() {
  const lines = [];
  for (const region of state.regions || []) {
    if (region.enabled === false) continue;
    if (region.polygon?.length) lines.push({ points: region.polygon, closed: true, source: '鋪磚區邊界' });
    for (const hole of region.holes || []) if (hole?.length) lines.push({ points: hole, closed: true, source: '孔洞邊界' });
  }
  for (const entity of state.cad?.entities || []) {
    if (!entity.points?.length || entity.type === 'HATCH') continue;
    lines.push({ points: entity.points, closed: Boolean(entity.closed), source: entity.layer || 'CAD 線' });
  }
  const activeIds = new Set(groupMembers(activeGroup()?.id || '').map((region) => region.id));
  for (const piece of state.layout.pieces || []) {
    if (activeIds.size && !activeIds.has(piece.regionId)) continue;
    if (piece.polygon?.length) lines.push({ points: piece.polygon, closed: true, source: '現有磚角點' });
  }
  for (const band of state.bands || []) {
    lines.push({ points: rectanglePolygon(band.minX, band.minY, band.maxX, band.maxY), closed: true, source: '伸縮縫邊' });
  }
  return lines;
}

function snapToExistingGeometry(point) {
  const tolerance = Math.max(0.5, 14 / Math.max(state.view.scale, 1e-6));
  const tolerance2 = tolerance * tolerance;
  const searchBox = { minX: point.x - tolerance, maxX: point.x + tolerance, minY: point.y - tolerance, maxY: point.y + tolerance };
  let bestEndpoint = null;
  let bestSegment = null;
  for (const line of collectSnapPolylines()) {
    const points = line.points || [];
    if (points.length < 2) continue;
    const box = bboxOfPoints(points);
    if (!bboxesIntersect(box, searchBox, 0)) continue;
    for (let index = 0; index < points.length; index += 1) {
      const vertex = points[index];
      const d2 = distance2(point, vertex);
      if (d2 <= tolerance2 && (!bestEndpoint || d2 < bestEndpoint.d2)) {
        bestEndpoint = { point: { x: vertex.x, y: vertex.y }, d2, type: '端點', source: line.source };
      }
      const nextIndex = index + 1;
      if (nextIndex >= points.length && !line.closed) continue;
      const next = points[nextIndex % points.length];
      const nearest = nearestPointOnSegment(point, vertex, next);
      const s2 = distance2(point, nearest.point);
      if (s2 <= tolerance2 && (!bestSegment || s2 < bestSegment.d2)) {
        bestSegment = { point: nearest.point, d2: s2, type: '線上', source: line.source };
      }
    }
  }
  return bestEndpoint || bestSegment || { point, type: '自由點', source: '' };
}

function canvasPoint(event) {
  const rect = dom.layoutCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function regionAtWorldPoint(point) {
  for (let index = state.regions.length - 1; index >= 0; index -= 1) {
    const region = state.regions[index];
    if (region.enabled !== false && pointInRegion(point, region)) return region;
  }
  return null;
}

function selectionWorldBBox(start, end) {
  const first = screenToWorld(start);
  const last = screenToWorld(end);
  return {
    minX: Math.min(first.x, last.x),
    maxX: Math.max(first.x, last.x),
    minY: Math.min(first.y, last.y),
    maxY: Math.max(first.y, last.y)
  };
}

function selectRegionsByScreenBox(start, end, { multi = false } = {}) {
  const box = selectionWorldBBox(start, end);
  const windowSelection = end.x >= start.x;
  const matches = state.regions.filter((region) => {
    if (region.enabled === false) return false;
    const regionBox = region.bbox || bboxOfPoints(region.polygon || []);
    return windowSelection
      ? regionBox.minX >= box.minX && regionBox.maxX <= box.maxX
        && regionBox.minY >= box.minY && regionBox.maxY <= box.maxY
      : bboxesIntersect(regionBox, box);
  });
  const ids = new Set(matches.map((region) => region.id));
  if (!multi) state.selection = ids;
  else for (const id of ids) state.selection.add(id);
  const first = matches[0] || activeRegion();
  if (first) {
    state.activeRegionId = first.id;
    state.activeGroupId = first.groupId || state.activeGroupId;
  }
  renderRegionList(); renderGroupControls(); renderCutTable(); requestRender();
  toast(`${windowSelection ? '窗口' : '交叉'}選取 ${matches.length} 個區域。`, matches.length ? 'success' : 'warning');
}


function candidateAlreadyExists(candidate) {
  return state.regions.some((region) => Math.abs(region.bbox.minX - candidate.bbox.minX) < 1
    && Math.abs(region.bbox.minY - candidate.bbox.minY) < 1
    && Math.abs(region.bbox.maxX - candidate.bbox.maxX) < 1
    && Math.abs(region.bbox.maxY - candidate.bbox.maxY) < 1);
}

function distanceToCandidateBoundary(point, candidate) {
  const points = candidate.points || [];
  if (points.length < 2) return Infinity;
  let best = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    const nearest = nearestPointOnSegment(point, points[index], next);
    best = Math.min(best, Math.hypot(point.x - nearest.point.x, point.y - nearest.point.y));
  }
  return best;
}

function pointMatchesClosedCandidate(point, candidate, boundaryTolerance) {
  if (!pointInBBox(point, candidate.bbox, boundaryTolerance)) return false;
  if (distanceToCandidateBoundary(point, candidate) <= boundaryTolerance) return true;
  if (!pointInPolygon(point, candidate.points)) return false;
  return !(candidate.holes || []).some((hole) => pointInPolygon(point, hole));
}

function pickClosedCandidateAt(point, { boundaryOnly = false } = {}) {
  const minimumArea = state.sourceMode === 'cad-pick'
    ? 1
    : Math.max(5000, Number(state.settings.tileLong || 450) * Number(state.settings.tileShort || 300) * 0.35);
  const boundaryTolerance = Math.max(2, 14 / Math.max(state.view.scale, 1e-6));
  const matchesPoint = (entity) => boundaryOnly
    ? pointInBBox(point, entity.bbox, boundaryTolerance) && distanceToCandidateBoundary(point, entity) <= boundaryTolerance
    : pointMatchesClosedCandidate(point, entity, boundaryTolerance);
  let candidates = [];
  if (state.layerMapping.region) {
    candidates = cadClosedCandidates(state.layerMapping.region)
      .filter(matchesPoint)
      .filter((entity) => entity.area >= minimumArea);
  }
  if (!candidates.length) {
    candidates = cadClosedCandidates('')
      .filter(matchesPoint)
      .filter((entity) => entity.area >= minimumArea);
  }
  candidates = candidates
    .filter((entity) => !candidateAlreadyExists(entity))
    .sort((a, b) => a.area - b.area || Math.min(a.bbox.width, a.bbox.height) - Math.min(b.bbox.width, b.bbox.height));
  return candidates[0] || null;
}

function addRegionFromPick(point, { boundaryOnly = false } = {}) {
  if (!state.cad) return toast('請先載入 DXF / DWG。', 'warning');
  const candidate = pickClosedCandidateAt(point, { boundaryOnly });
  if (!candidate) return toast('此點未找到可加入的最小閉合區域。可先調整圖層或放大後再試。', 'warning');
  pushHistory();
  let group = activeGroup();
  const referenceRegion = activeRegion();
  if (!group) {
    const id = stableId('group');
    group = createGroup(id, '新增區域組', candidate.bbox.minX, candidate.bbox.minY, '#0b6bcb');
    state.groups.push(group);
  }
  const regionNumber = String(state.regions.length + 1).padStart(2, '0');
  const region = {
    id: stableId('region'),
    name: `區域 ${regionNumber}`,
    polygon: cleanPolygon(candidate.points),
    bbox: bboxOfPoints(candidate.points),
    rotation: normalizeRotation(referenceRegion?.rotation ?? 0),
    groupId: group.id,
    originX: referenceRegion?.originX ?? group.originX ?? candidate.bbox.minX,
    originY: referenceRegion?.originY ?? group.originY ?? candidate.bbox.minY,
    approximate: false,
    manualCad: true,
    sourceKind: boundaryOnly ? 'cad-boundary-pick' : 'cad-interior-pick',
    sourceHandle: candidate.handle || '',
    sourceLayer: candidate.layer || '',
    sourceVertices: candidate.points.length,
    holes: (candidate.holes || []).map((hole) => cleanPolygon(hole)),
    enabled: true
  };
  state.regions.push(region);
  state.exactCount = state.regions.filter((item) => item.approximate !== true).length;
  state.selection = new Set([region.id]);
  state.activeRegionId = region.id;
  state.activeGroupId = group.id;
  renderAllControls();
  scheduleLayout();
  zoomToRegion(region);
  toast(`已新增 ${region.name}（來自 ${candidate.layer || 'CAD'} 的閉合區域）。`, 'success');
}

function makeBandFromDrag(start, end, width) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const centerY = (start.y + end.y) / 2;
    return { axis: 'y', minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x), minY: centerY - width / 2, maxY: centerY + width / 2 };
  }
  const centerX = (start.x + end.x) / 2;
  return { axis: 'x', minX: centerX - width / 2, maxX: centerX + width / 2, minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) };
}

function showCanvasTooltip(screen, world) {
  const region = regionAtWorldPoint(world);
  if (!region) { dom.canvasTooltip.hidden = true; return; }
  const group = groupById(region.groupId);
  const size = nominalTileSize(state.settings, region.rotation);
  dom.canvasTooltip.innerHTML = `<strong>${escapeHtml(region.name)}</strong><br>${escapeHtml(group?.name || '未分組')} · ${rotationLabel(region.rotation)}<br>名義磚：X ${formatMm(size.width, 0)} × Y ${formatMm(size.height, 0)} mm<br>區域：${formatMm(region.bbox.width, 0)} × ${formatMm(region.bbox.height, 0)} mm${region.holes?.length ? `<br>HATCH 孔洞：${region.holes.length}` : ''}${region.approximate ? '<br>QA 外框預覽，未作施工精度確認' : ''}`;
  dom.canvasTooltip.style.left = `${Math.min(screen.x + 14, dom.canvasFrame.clientWidth - 290)}px`;
  dom.canvasTooltip.style.top = `${Math.min(screen.y + 14, dom.canvasFrame.clientHeight - 100)}px`;
  dom.canvasTooltip.hidden = false;
}

function touchPoints() {
  return [...state.interaction.touchPointers.values()];
}

function touchCenter(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function touchDistance(points) {
  if (points.length < 2) return 0;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function applyPinchZoom() {
  const points = touchPoints();
  const pinch = state.interaction.pinch;
  if (points.length < 2 || !pinch || pinch.startDistance < 1) return;
  const metrics = resizeCanvas();
  const center = touchCenter(points);
  const scale = clamp(pinch.startScale * touchDistance(points) / pinch.startDistance, 1e-5, 5);
  state.view.scale = scale;
  // Keep the world point below the two fingers fixed while the midpoint moves.
  state.view.centerX = pinch.anchorWorld.x - (center.x - metrics.width / 2) / scale;
  state.view.centerY = pinch.anchorWorld.y + (center.y - metrics.height / 2) / scale;
  requestRender();
}

function handleCanvasPointerDown(event) {
  const screen = canvasPoint(event);
  const world = screenToWorld(screen);
  const touch = event.pointerType === 'touch';
  state.interaction.longPress = false;
  const touchMap = state.interaction.touchPointers || new Map();
  state.interaction.touchPointers = touchMap;
  if (touch) touchMap.set(event.pointerId, screen);

  const panAction = event.button === 1 || state.mode === 'pan';
  state.interaction.dragging = true;
  state.interaction.moved = false;
  state.interaction.action = panAction ? 'pan' : state.mode;
  state.interaction.startScreen = screen;
  state.interaction.startWorld = world;
  state.interaction.startView = { ...state.view };
  state.interaction.bandPreview = null;
  const rectangleSelect = state.mode === 'select' && event.pointerType !== 'touch' && event.button === 0 && !panAction;
  state.interaction.selectionBox = rectangleSelect ? { start: screen, end: screen } : null;
  state.interaction.selectionBoxModifier = rectangleSelect && (event.shiftKey || event.ctrlKey || event.metaKey);
  state.interaction.pinch = null;

  if (touch && touchMap.size >= 2) {
    cancelTouchLongPress();
    const points = touchPoints();
    const center = touchCenter(points);
    state.interaction.action = 'pinch';
    state.interaction.moved = true;
    state.interaction.pinch = {
      startDistance: touchDistance(points),
      startScale: state.view.scale,
      anchorWorld: screenToWorld(center)
    };
  }

  if (touch && state.mode === 'select' && !panAction && touchMap.size === 1) {
    scheduleTouchLongPress(regionAtWorldPoint(world), screen);
  }

  dom.layoutCanvas.setPointerCapture(event.pointerId);
  if (panAction || state.interaction.action === 'pinch') dom.layoutCanvas.classList.add('dragging');
  event.preventDefault();
}

function handleCanvasPointerMove(event) {
  const screen = canvasPoint(event);
  const world = screenToWorld(screen);
  if (event.pointerType === 'touch' && state.interaction.touchPointers?.has(event.pointerId)) {
    state.interaction.touchPointers.set(event.pointerId, screen);
  }
  if (state.interaction.action === 'pinch') {
    applyPinchZoom();
    dom.canvasTooltip.hidden = true;
    return;
  }
  if (!state.interaction.dragging && state.mode === 'origin') {
    const snapped = snapToExistingGeometry(world);
    state.interaction.snapPreview = snapped;
    dom.cursorCoordinateLabel.textContent = `${formatMm(snapped.point.x, 1)}, ${formatMm(snapped.point.y, 1)} · ${snapped.type}`;
    dom.canvasTooltip.hidden = true;
    requestRender();
    return;
  }
  state.interaction.snapPreview = null;
  dom.cursorCoordinateLabel.textContent = `${formatMm(world.x, 1)}, ${formatMm(world.y, 1)}`;
  if (!state.interaction.dragging) { showCanvasTooltip(screen, world); return; }
  const deltaX = screen.x - state.interaction.startScreen.x;
  const deltaY = screen.y - state.interaction.startScreen.y;
  if (Math.hypot(deltaX, deltaY) > 3) {
    state.interaction.moved = true;
    if (event.pointerType === 'touch') cancelTouchLongPress();
    if (state.interaction.action === 'select' && event.pointerType !== 'touch') {
      state.interaction.selectionBox = {
        start: state.interaction.startScreen,
        end: screen
      };
      requestRender();
    }
  }
  if (state.interaction.action === 'select' && event.pointerType === 'touch' && state.interaction.moved) {
    // On iPad a drag in select mode pans; a short tap still selects a region.
    state.interaction.action = 'pan';
    dom.layoutCanvas.classList.add('dragging');
  }
  if (state.interaction.action === 'pan') {
    state.view.centerX = state.interaction.startView.centerX - deltaX / state.view.scale;
    state.view.centerY = state.interaction.startView.centerY + deltaY / state.view.scale;
    requestRender();
  } else if (state.interaction.action === 'band') {
    const width = Math.max(1, Math.round(numeric(dom.bandWidthInput, 20)));
    state.interaction.bandPreview = makeBandFromDrag(state.interaction.startWorld, world, width);
    requestRender();
  }
  dom.canvasTooltip.hidden = true;
}

function selectRegionOnCanvas(region, event) {
  const modifierMulti = event.shiftKey || event.ctrlKey || event.metaKey;
  const touchMulti = event.pointerType === 'touch' && state.touchMergeMode;
  const multi = modifierMulti || touchMulti;
  if (!region) {
    if (!multi) state.selection.clear();
  } else selectRegionSelection(region, { multi, toggle: modifierMulti && !touchMulti });
  renderRegionList(); renderGroupControls(); renderCutTable(); requestRender();
}

function inferOriginAlignment(point, region) {
  const bbox = region?.bbox || bboxOfPoints(region?.polygon || []);
  const center = polygonCentroid(region?.polygon || []);
  const sign = (value, fallback) => Math.abs(value) < 1e-6 ? fallback : (value < 0 ? -1 : 1);
  const tolerance = Math.max(2, 16 / Math.max(state.view.scale, 1e-6));
  const xSign = Math.abs(point.x - bbox.minX) <= tolerance ? 1
    : Math.abs(point.x - bbox.maxX) <= tolerance ? -1
      : sign(center.x - point.x, 1);
  const ySign = Math.abs(point.y - bbox.minY) <= tolerance ? 1
    : Math.abs(point.y - bbox.maxY) <= tolerance ? -1
      : sign(center.y - point.y, 1);
  return {
    x: xSign,
    y: ySign,
    // The staggered row/column touching a negative-side corner has index -1.
    // Flip its parity so the selected corner starts without a half-tile shift.
    staggerPhaseX: xSign < 0 ? 1 : 0,
    staggerPhaseY: ySign < 0 ? 1 : 0
  };
}

function setOriginAt(point) {
  const snapped = snapToExistingGeometry(point);
  point = snapped.point;
  const group = activeGroup();
  const region = activeRegion();
  if (!group) return toast('請先選擇排布組。', 'warning');
  pushHistory();
  const target = group.unifiedOrigin !== false ? group : region;
  if (!target) return;
  const alignment = inferOriginAlignment(point, region);
  target.originX = point.x;
  target.originY = point.y;
  target.originAlignX = alignment.x;
  target.originAlignY = alignment.y;
  target.staggerPhaseX = alignment.staggerPhaseX;
  target.staggerPhaseY = alignment.staggerPhaseY;
  target.offsetX = target.offsetY = target.up = target.down = target.left = target.right = 0;
  renderGroupControls(); scheduleLayout();
  toast(`起點已設為 ${formatMm(point.x, 0)}, ${formatMm(point.y, 0)} mm${snapped.type !== '自由點' ? `（已吸附${snapped.type}：${snapped.source}）` : ''}。`, 'success');
  state.interaction.snapPreview = null;
  setMode('select');
}


function splitCurrentRegionsByManualBand(band) {
  const targetGroupId = band.global ? null : band.groupId;
  const output = [];
  const replacementByOldId = new Map();
  let dividedRegions = 0;
  let createdRegions = 0;

  for (const region of state.regions) {
    if (region.enabled === false || (targetGroupId && region.groupId !== targetGroupId) || !bboxesIntersect(region.bbox, band, 5)) {
      output.push(region);
      continue;
    }
    const component = {
      polygon: region.polygon,
      holes: region.holes || [],
      sourceHandle: region.sourceHandle || '',
      sourceLayer: region.sourceLayer || '',
      sourcePattern: region.sourcePattern || '',
      sourcePathIndex: region.sourcePathIndex ?? 0
    };
    const parts = splitHatchComponentsByBands([component], [band], { jointEndExtension: 5 });
    if (parts.length <= 1) {
      output.push(region);
      continue;
    }
    dividedRegions += 1;
    const replacements = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const polygon = cleanPolygon(part.polygon || []);
      if (polygon.length < 3) continue;
      const suffix = String.fromCharCode(65 + Math.min(index, 25));
      const id = `${region.id}-manual-${Date.now().toString(36)}-${index}`;
      const newRegion = {
        ...region,
        id,
        name: `${region.name}-${suffix}`,
        polygon,
        holes: (part.holes || []).map((hole) => cleanPolygon(hole)),
        bbox: bboxOfPoints(polygon),
        splitByJointIds: [...new Set([...(region.splitByJointIds || []), band.id])],
        manualSplitParentId: region.id,
        manualSplitIndex: index,
        manualSplitCount: parts.length
      };
      replacements.push(newRegion);
      output.push(newRegion);
      createdRegions += 1;
    }
    replacementByOldId.set(region.id, replacements);
  }

  if (!dividedRegions) return { dividedRegions: 0, createdRegions: 0 };
  state.regions = output;
  for (const group of state.groups) {
    const replacements = replacementByOldId.get(group.anchorRegionId);
    if (replacements?.length) group.anchorRegionId = replacements[0].id;
  }
  const newSelection = new Set();
  for (const id of state.selection) {
    const replacements = replacementByOldId.get(id);
    if (replacements?.length) for (const region of replacements) newSelection.add(region.id);
    else if (state.regions.some((region) => region.id === id)) newSelection.add(id);
  }
  state.selection = newSelection;
  const activeReplacements = replacementByOldId.get(state.activeRegionId);
  if (activeReplacements?.length) state.activeRegionId = activeReplacements[0].id;
  state.splitRegionCount = state.regions.length;
  state.exactCount = state.regions.length;
  return { dividedRegions, createdRegions };
}

function handleCanvasPointerUp(event) {
  if (event.pointerType === 'touch' && state.interaction.touchPointers?.has(event.pointerId)) {
    state.interaction.touchPointers.delete(event.pointerId);
    const remaining = touchPoints();
    if (remaining.length) {
      if (state.interaction.action === 'pinch' && remaining.length === 1) {
        state.interaction.action = 'pan';
        state.interaction.startScreen = remaining[0];
        state.interaction.startView = { ...state.view };
        state.interaction.moved = true;
        state.interaction.pinch = null;
      }
      return;
    }
  }
  if (!state.interaction.dragging) return;
  const screen = canvasPoint(event);
  const world = screenToWorld(screen);
  const action = state.interaction.action;
  const moved = state.interaction.moved;
  const longPress = state.interaction.longPress;
  const preview = state.interaction.bandPreview;
  const selectionBox = state.interaction.selectionBox;
  const selectionBoxModifier = state.interaction.selectionBoxModifier;
  cancelTouchLongPress();
  state.interaction.longPress = false;
  state.interaction.dragging = false;
  state.interaction.bandPreview = null;
  state.interaction.selectionBox = null;
  state.interaction.selectionBoxModifier = false;
  dom.layoutCanvas.classList.remove('dragging');
  try { dom.layoutCanvas.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  if (action === 'select' && !moved && !longPress) selectRegionOnCanvas(regionAtWorldPoint(world), event);
  else if (action === 'select' && moved && selectionBox) {
    selectRegionsByScreenBox(selectionBox.start, selectionBox.end, { multi: selectionBoxModifier });
  }
  else if (action === 'origin' && !moved) setOriginAt(world);
  else if (action === 'pickRegion' && !moved) addRegionFromPick(world);
  else if (action === 'pickBoundary' && !moved) addRegionFromPick(world, { boundaryOnly: true });
  else if (action === 'band' && preview) {
    const length = preview.axis === 'x' ? preview.maxY - preview.minY : preview.maxX - preview.minX;
    if (length < 10) return toast('分界帶太短，請沿分界長方向拖動。', 'warning');
    pushHistory();
    const band = {
      ...preview,
      id: stableId('band'),
      type: dom.bandTypeInput.value.trim() || '分界帶',
      groupId: activeGroup()?.id || null,
      global: dom.bandGlobalInput.checked,
      enabled: true,
      visible: true,
      source: 'manual-region-cut'
    };
    const split = splitCurrentRegionsByManualBand(band);
    if (!split.dividedRegions) {
      toast('此斷帶沒有完整切開任何鋪磚區域，未建立分界。', 'warning');
    } else {
      state.bands.push(band);
      renderAllControls(); scheduleLayout();
      toast(`已用手動斷帶切開 ${split.dividedRegions} 個區域，生成 ${split.createdRegions} 個最小倉；可用「復原」撤銷。`, 'success');
    }
  }
  requestRender();
}

function handleCanvasWheel(event) {
  event.preventDefault();
  const screen = canvasPoint(event);
  const queue = state.interaction.zoomQueue;
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  queue.factor = clamp(queue.factor * Math.exp(-delta * .0012), .25, 4);
  queue.screen = screen;
  if (queue.frame) return;
  queue.frame = requestAnimationFrame(() => {
    queue.frame = 0;
    const anchor = queue.screen || screen;
    const before = screenToWorld(anchor);
    state.view.scale = clamp(state.view.scale * queue.factor, 1e-5, 5);
    const after = screenToWorld(anchor);
    state.view.centerX += before.x - after.x;
    state.view.centerY += before.y - after.y;
    queue.factor = 1;
    queue.screen = null;
    requestRender();
  });
}

function selectAllVisibleRegions() {
  state.selection = new Set(state.regions.map((region) => region.id));
  const first = selectedRegions()[0];
  if (first) { state.activeRegionId = first.id; state.activeGroupId = first.groupId; }
  renderRegionList(); renderGroupControls(); renderCutTable(); requestRender();
}

function removeEmptyGroups() {
  const used = new Set(state.regions.map((region) => region.groupId));
  state.groups = state.groups.filter((group) => used.has(group.id));
}

function isRemovableHatchRegion(region) {
  return state.sourceMode === 'hatch'
    && region?.manualCad !== true
    && region?.approximate !== true
    && !region?.manualSplitParentId;
}

function removeSelectedHatchRegions() {
  const selectedHatch = state.regions.filter((region) => state.selection.has(region.id) && isRemovableHatchRegion(region));
  if (!selectedHatch.length) return toast('請先選取要移除的原始 HATCH 區域。', 'warning');
  if (!window.confirm(`移除 ${selectedHatch.length} 個 HATCH 區域？可用 Ctrl+Z 復原。`)) return;
  pushHistory();
  const deletedIds = new Set(selectedHatch.map((region) => region.id));
  for (const region of selectedHatch) {
    state.removedHatchKeys.add(String(region.hatchRegionKey || hatchRegionKey(region)));
  }
  state.regions = state.regions.filter((region) => !deletedIds.has(region.id));
  state.selection = new Set([...state.selection].filter((id) => !deletedIds.has(id)));
  removeEmptyGroups();
  if (!regionById(state.activeRegionId)) {
    const nextRegion = state.regions[0] || null;
    state.activeRegionId = nextRegion?.id || null;
    state.activeGroupId = nextRegion?.groupId || state.groups[0]?.id || null;
  } else if (!groupById(state.activeGroupId)) {
    state.activeGroupId = activeRegion()?.groupId || state.groups[0]?.id || null;
  }
  if (!state.selection.size && state.activeRegionId) state.selection = new Set([state.activeRegionId]);
  state.exactCount = state.regions.filter((region) => region.approximate !== true).length;
  state.splitRegionCount = state.regions.length;
  renderAllControls();
  scheduleLayout();
  fitView();
  toast(`已移除 ${selectedHatch.length} 個 HATCH 區域。`, 'success');
}

function deleteSelectedManualRegions() {
  const selectedManual = selectedRegions().filter((region) => region.manualCad === true);
  if (!selectedManual.length) return toast('只有用 CAD 取區／選閉合線新增的區域可以刪除。', 'warning');
  if (!window.confirm(`刪除 ${selectedManual.length} 個新增區域？原始 HATCH 區域不會被刪除。`)) return;
  pushHistory();
  const deletedIds = new Set(selectedManual.map((region) => region.id));
  state.regions = state.regions.filter((region) => !deletedIds.has(region.id));
  state.selection = new Set([...state.selection].filter((id) => !deletedIds.has(id)));
  removeEmptyGroups();
  if (!regionById(state.activeRegionId)) {
    const nextRegion = state.regions[0] || null;
    state.activeRegionId = nextRegion?.id || null;
    state.activeGroupId = nextRegion?.groupId || state.groups[0]?.id || null;
  } else if (!groupById(state.activeGroupId)) {
    state.activeGroupId = activeRegion()?.groupId || state.groups[0]?.id || null;
  }
  if (!state.selection.size && state.activeRegionId) state.selection = new Set([state.activeRegionId]);
  state.exactCount = state.regions.filter((region) => region.approximate !== true).length;
  state.splitRegionCount = state.regions.length;
  renderAllControls();
  scheduleLayout();
  fitView();
  toast(`已刪除 ${selectedManual.length} 個新增區域。`, 'success');
}


function defaultCornerOriginForRegion(region) {
  return { x: region.bbox.minX, y: region.bbox.minY };
}

function originLooksCustomized(region, group) {
  if (!region || !group) return false;
  const origin = effectiveOrigin(region, group);
  const corner = defaultCornerOriginForRegion(region);
  return Math.hypot(origin.x - corner.x, origin.y - corner.y) > 1;
}

function expandedSelectionWithPersistentGroups() {
  const direct = selectedRegions();
  const ids = new Set(direct.map((region) => region.id));
  for (const region of direct) {
    const members = groupMembers(region.groupId);
    if (members.length > 1) for (const member of members) ids.add(member.id);
  }
  return state.regions.filter((region) => ids.has(region.id));
}

function mergeSelectedRegions() {
  const direct = selectedRegions();
  if (direct.length < 2) return toast('請按住 Ctrl／Command 點選至少兩個區域，再按合併。', 'warning');
  const selected = expandedSelectionWithPersistentGroups();
  pushHistory();

  const activeExisting = activeGroup();
  const reusable = activeExisting
    && groupMembers(activeExisting.id).length > 1
    && selected.some((region) => region.groupId === activeExisting.id);
  const id = reusable ? activeExisting.id : stableId('group');

  const existingAnchor = reusable
    ? regionById(activeExisting.anchorRegionId) || groupMembers(activeExisting.id)[0]
    : null;
  const horizontalCount = selected.filter((region) => normalizeRotation(region.rotation) === 0).length;
  // When extending an existing persistent group, keep its established long-side
  // direction. A later merge must not silently flip the whole group because the
  // newly added bays happen to be the majority.
  const groupRotation = existingAnchor
    ? normalizeRotation(existingAnchor.rotation)
    : horizontalCount >= selected.length - horizontalCount ? 0 : 90;
  let anchor = null;
  if (reusable && activeExisting.anchorRegionId) anchor = regionById(activeExisting.anchorRegionId);
  if (!anchor || !selected.some((region) => region.id === anchor.id)) {
    anchor = [...selected].sort((a, b) => groupRotation === 0
      ? a.bbox.minX - b.bbox.minX || a.bbox.minY - b.bbox.minY
      : a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX)[0];
  }

  const previousGroups = new Set(selected.map((region) => region.groupId));
  const sourceAnchorGroup = groupById(anchor.groupId);
  const customOrigin = sourceAnchorGroup && originLooksCustomized(anchor, sourceAnchorGroup);
  const anchorOrigin = customOrigin
    ? effectiveOrigin(anchor, sourceAnchorGroup)
    : defaultCornerOriginForRegion(anchor);

  const group = reusable
    ? activeExisting
    : createGroup(id, `統一排布 ${state.groups.length + 1}`, anchorOrigin.x, anchorOrigin.y, '#0c8b77');
  group.unifiedOrigin = true;
  group.carryAcross = true;
  group.anchorRegionId = anchor.id;
  if (!reusable) state.groups.push(group);
  if (!reusable || !originLooksCustomized(anchor, group)) {
    group.originX = anchorOrigin.x;
    group.originY = anchorOrigin.y;
    group.offsetX = 0; group.offsetY = 0;
    group.up = 0; group.down = 0; group.left = 0; group.right = 0;
    group.originAlignX = customOrigin ? Number(sourceAnchorGroup.originAlignX || 0) : 0;
    group.originAlignY = customOrigin ? Number(sourceAnchorGroup.originAlignY || 0) : 0;
    group.staggerPhaseX = customOrigin ? Number(sourceAnchorGroup.staggerPhaseX || 0) : 0;
    group.staggerPhaseY = customOrigin ? Number(sourceAnchorGroup.staggerPhaseY || 0) : 0;
  }

  // A persistent group must use one direction and one stagger phase. Mixed
  // directions are normalized to the anchor/majority direction on merge.
  for (const region of selected) {
    region.groupId = id;
    region.rotation = groupRotation;
  }
  removeEmptyGroups();
  state.activeGroupId = id;
  state.activeRegionId = anchor.id;
  state.selection = new Set(selected.map((region) => region.id));
  state.touchMergeMode = false;
  renderAllControls();
  scheduleLayout();
  toast(`已建立持續合併組：${selected.length} 個最小倉共用一個起點、${formatMm(state.settings.staggerOffset, 0)} mm錯縫及跨空隙續排；只有「獨立排布」會解除。`, 'success');
}

function splitSelectedRegions() {
  const selected = expandedSelectionWithPersistentGroups();
  if (!selected.length) return toast('請先選擇一個合併組或區域。', 'warning');
  pushHistory();
  for (const region of selected) {
    const oldGroup = groupById(region.groupId);
    const id = stableId('group');
    const origin = oldGroup ? effectiveOrigin(region, oldGroup) : { x: region.originX ?? region.bbox.minX, y: region.originY ?? region.bbox.minY };
    state.groups.push({
      ...createGroup(id, `${region.name} 獨立`, origin.x, origin.y, normalizeRotation(region.rotation) === 90 ? '#7a49a5' : '#0b6bcb'),
      anchorRegionId: region.id
    });
    const newGroup = state.groups.at(-1);
    if (oldGroup) {
      newGroup.originAlignX = Number(oldGroup.originAlignX || 0);
      newGroup.originAlignY = Number(oldGroup.originAlignY || 0);
      newGroup.staggerPhaseX = Number(oldGroup.staggerPhaseX || 0);
      newGroup.staggerPhaseY = Number(oldGroup.staggerPhaseY || 0);
    }
    region.groupId = id;
    region.originX = origin.x;
    region.originY = origin.y;
  }
  removeEmptyGroups();
  state.activeGroupId = selected[0].groupId;
  state.activeRegionId = selected[0].id;
  state.selection = new Set(selected.map((region) => region.id));
  state.touchMergeMode = false;
  renderAllControls(); scheduleLayout();
  toast(`已解除合併，${selected.length} 個區域恢復獨立起點。`, 'success');
}


function changeSelectedOrientation() {
  if (dom.selectedOrientationInput.value === 'mixed') return;
  const rotation = dom.selectedOrientationInput.value === '90' ? 90 : 0;
  // A persistent group owns one direction and one running-bond phase. Selecting
  // any member and changing direction therefore updates the complete group.
  const selected = expandedSelectionWithPersistentGroups();
  if (!selected.length) return;
  pushHistory();
  for (const region of selected) region.rotation = rotation;
  updateSourceMetrics(); renderRegionList(); renderGroupControls(); scheduleLayout();
  toast(`已將 ${selected.length} 個區域（含完整合併組）設為${rotationLabel(rotation)}。`, 'success');
}

function rotateSelectedRegions() {
  const selected = expandedSelectionWithPersistentGroups();
  if (!selected.length) return toast('請先選擇區域。', 'warning');
  pushHistory();
  const byGroup = new Map();
  for (const region of selected) {
    const list = byGroup.get(region.groupId) || [];
    list.push(region);
    byGroup.set(region.groupId, list);
  }
  for (const [groupId, members] of byGroup) {
    const group = groupById(groupId);
    const persistent = group && groupMembers(groupId).length > 1;
    if (persistent) {
      const anchor = regionById(group.anchorRegionId) || members[0];
      const rotation = normalizeRotation(anchor.rotation) === 90 ? 0 : 90;
      for (const region of members) region.rotation = rotation;
    } else {
      for (const region of members) region.rotation = normalizeRotation(region.rotation) === 90 ? 0 : 90;
    }
  }
  updateSourceMetrics(); renderRegionList(); renderGroupControls(); scheduleLayout();
  toast(`已將 ${selected.length} 個區域旋轉 90°；合併組保持統一方向。`, 'success');
}

async function optimizeActiveOrigin() {
  const group = activeGroup();
  const region = activeRegion();
  if (!group || !region) return toast('請先選擇一個區域或排布組。', 'warning');
  const unified = group.unifiedOrigin !== false;
  const regions = unified ? groupMembers(group.id) : [region];
  const optimizationGroup = unified ? group : {
    ...group,
    id: region.groupId,
    unifiedOrigin: true,
    carryAcross: false,
    originX: region.originX,
    originY: region.originY,
    offsetX: region.offsetX,
    offsetY: region.offsetY,
    up: region.up,
    down: region.down,
    left: region.left,
    right: region.right
  };
  dom.optimizeOriginButton.disabled = true;
  dom.optimizeOriginButton.textContent = '正在搜尋最佳起點…';
  dom.calculationBadge.textContent = '智能優化中';
  dom.calculationBadge.className = 'calculation-badge busy';
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const result = optimizeGroupOrigin({
      settings: state.settings,
      regions,
      group: optimizationGroup,
      bands: state.bands
    });
    pushHistory();
    const target = unified ? group : region;
    target.originX = result.originX;
    target.originY = result.originY;
    target.offsetX = 0;
    target.offsetY = 0;
    target.up = 0;
    target.down = 0;
    target.left = 0;
    target.right = 0;
    renderGroupControls();
    scheduleLayout();
    const before = Number(result.current.stats?.smallCutPieces || 0);
    const after = Number(result.layout.stats?.smallCutPieces || 0);
    toast(`已評估 ${result.evaluations} 個起點：小於 ${formatMm(state.settings.minCut, 0)} mm 的磚由 ${before} 塊降至 ${after} 塊。`, after < before ? 'success' : 'warning');
  } catch (error) {
    toast(error.message, 'warning');
    dom.calculationBadge.textContent = '優化未套用';
    dom.calculationBadge.className = 'calculation-badge error';
  } finally {
    dom.optimizeOriginButton.disabled = false;
    dom.optimizeOriginButton.textContent = '智能優化起點';
  }
}

function updateOriginInputs() {
  const group = activeGroup();
  const region = activeRegion();
  if (!group) return;
  const target = group.unifiedOrigin !== false ? group : region;
  if (!target) return;
  target.originX = numeric(dom.originXInput, target.originX || 0);
  target.originY = numeric(dom.originYInput, target.originY || 0);
  target.up = integerMm(dom.nudgeUpInput, 0);
  target.down = integerMm(dom.nudgeDownInput, 0);
  target.left = integerMm(dom.nudgeLeftInput, 0);
  target.right = integerMm(dom.nudgeRightInput, 0);
  dom.nudgeUpInput.value = target.up;
  dom.nudgeDownInput.value = target.down;
  dom.nudgeLeftInput.value = target.left;
  dom.nudgeRightInput.value = target.right;
  scheduleLayout();
}

function nudgeActiveOrigin(dx, dy) {
  const group = activeGroup();
  const region = activeRegion();
  if (!group) return;
  const target = group.unifiedOrigin !== false ? group : region;
  if (!target) return;
  pushHistory();
  target.originX = Number(target.originX || 0) + dx;
  target.originY = Number(target.originY || 0) + dy;
  renderGroupControls(); scheduleLayout();
}

function commitMoveInputs() {
  const group = activeGroup();
  const region = activeRegion();
  const target = group?.unifiedOrigin !== false ? group : region;
  if (!target) return toast('請先選擇區域或排布組。', 'warning');
  const dx = integerMm(dom.nudgeRightInput, 0) - integerMm(dom.nudgeLeftInput, 0);
  const dy = integerMm(dom.nudgeUpInput, 0) - integerMm(dom.nudgeDownInput, 0);
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    dom.confirmMoveButton.blur?.();
    return toast('請輸入 X／Y 或上下左右移動數字。', 'warning');
  }
  pushHistory();
  target.originX = Number(target.originX || 0) + dx;
  target.originY = Number(target.originY || 0) + dy;
  target.offsetX = 0; target.offsetY = 0;
  target.up = 0; target.down = 0; target.left = 0; target.right = 0;
  renderGroupControls();
  scheduleLayout();
  toast(`已確認移動 X ${formatMm(dx, 0)} mm、Y ${formatMm(dy, 0)} mm；輸入數字已清空。`, 'success');
}

function autoDetectBands() {
  toast(`已使用嚴格標定規則：RRIA - floor finish／ANSI32／20±0.75 mm／長度至少250 mm。目前識別 ${state.detectedJointCount} 條邏輯伸縮縫；1–5 mm線條不會納入。`, 'success');
}

function undo() {
  const project = state.history.pop();
  if (!project) return toast('沒有可復原的操作。', 'warning');
  restoreProject(project, true);
  dom.undoButton.disabled = state.history.length === 0;
  toast('已復原上一個操作。', 'success');
}

function saveProject() {
  if (saveAutoProject()) toast('排布設定已保存於此裝置。', 'success');
}

function exportCutCsv() {
  const header = [
    'Region','Group','Tile ID','Piece No.','Long Side Direction','Rotation','Nominal X mm','Nominal Y mm',
    'Piece Width mm','Piece Height mm','Minimum Dimension mm','Minimum Edge mm','Area m2','Continuation Across Separator','Small Cut','Rectangular',
    'Approximate Source','Polygon Coordinates mm'
  ];
  const rows = [header];
  for (const piece of state.layout.pieces.filter((item) => item.cut)) {
    rows.push([
      piece.regionName, piece.groupName, piece.tileId, piece.fragmentIndex + 1, `LONG-${piece.longAxis}`, piece.rotation,
      piece.nominalWidth.toFixed(0), piece.nominalHeight.toFixed(0), piece.width.toFixed(0), piece.height.toFixed(0),
      (piece.minimumDimension ?? Math.min(piece.width, piece.height)).toFixed(0), (piece.minEdge ?? Math.min(piece.width, piece.height)).toFixed(0),
      (piece.area / 1_000_000).toFixed(6), piece.continuation ? 'YES' : 'NO', piece.smallCut ? 'YES' : 'NO',
      piece.rectangular ? 'YES' : 'NO', piece.sourceApproximate ? 'YES' : 'NO', piece.coordinates
    ]);
  }
  const csv = `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}`;
  downloadBlob(csv, 'Roof-Tile-Cut-Schedule.csv', 'text/csv;charset=utf-8');
  toast(`已輸出 ${rows.length - 1} 筆非整磚資料。`, 'success');
}

function exportSvg() {
  const bbox = expandBBox(modelBBox(), 500);
  const width = bbox.width; const height = bbox.height;
  const mapY = (y) => bbox.maxY - y;
  const polygonPoints = (polygon) => polygon.map((point) => `${(point.x - bbox.minX).toFixed(2)},${mapY(point.y).toFixed(2)}`).join(' ');
  const regionSvg = state.regions.filter((region) => region.enabled !== false).map((region) => {
    const stroke = region.approximate ? '#9b670e' : '#273847';
    const dash = region.approximate ? 'stroke-dasharray="80 50"' : '';
    const outer = `<polygon points="${polygonPoints(region.polygon)}" fill="none" stroke="${stroke}" stroke-width="18" ${dash}/>`;
    const holes = (region.holes || []).map((hole) => `<polygon points="${polygonPoints(hole)}" fill="none" stroke="${stroke}" stroke-width="18"/>`).join('');
    return `${outer}${holes}`;
  }).join('\n');
  const exportBands = state.bands.filter((band) => band.enabled !== false && band.visible !== false);
  const bandSvg = exportBands.map((band) => {
    const x = band.minX - bbox.minX; const y = mapY(band.maxY);
    const isChannel = /渠|CHANNEL|DRAIN/i.test(band.type || '');
    const fill = isChannel ? '#c6d0db' : '#e21d63';
    const stroke = isChannel ? '#5c7082' : '#8f1645';
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(band.maxX - band.minX).toFixed(2)}" height="${(band.maxY - band.minY).toFixed(2)}" fill="${fill}" fill-opacity="0.96" stroke="${stroke}" stroke-width="12"/>`;
  }).join('\n');
  const exportRoleLayers = mappedLayoutLayerNames();
  const architectureEntities = state.settings.showCad && state.settings.keepArchitectureOnTop && state.cad
    ? state.cad.entities.filter((entity) => !isLayoutRoleEntity(entity, exportRoleLayers) && bboxesIntersect(entityBBox(entity), bbox)).slice(0, 30000)
    : [];
  const architecturePaths = architectureEntities.map((entity) => {
    const points = polygonPoints(entity.points || []);
    if (!points) return '';
    const tag = entity.closed ? 'polygon' : 'polyline';
    return `<${tag} points="${points}" fill="none"/>`;
  }).join('\n');
  const architectureSvg = architecturePaths
    ? `<g id="architecture-halo" stroke="#ffffff" stroke-opacity=".94" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">${architecturePaths}</g>\n<g id="architecture-linework" stroke="#1f2d3a" stroke-opacity=".94" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">${architecturePaths}</g>`
    : '';
  const exportPieces = state.layout.pieces.filter((piece) => piece.cut || state.settings.showFullTiles);
  const pieceSvg = exportPieces.map((piece) => {
    const fill = piece.smallCut ? '#f6c7cd' : piece.continuation ? '#df6e20' : piece.cut ? '#efa944' : '#7db4d8';
    const stroke = piece.smallCut ? '#a61c29' : piece.continuation ? '#df6e20' : piece.cut ? '#efa944' : '#7db4d8';
    return `<polygon points="${polygonPoints(piece.polygon)}" fill="${fill}" fill-opacity="${piece.smallCut ? '.82' : piece.cut ? '.42' : '.16'}" stroke="${stroke}" stroke-width="5"/>`;
  }).join('\n');
  const tileHatchSvg = exportPieces.map((piece) => `<polygon points="${polygonPoints(piece.polygon)}" fill="url(#tileHatch)" fill-opacity="${piece.smallCut ? '.9' : '.55'}" stroke="none"/>`).join('\n');
  const labelSvg = state.layout.pieces.filter((piece) => piece.cut).slice(0, 3500).map((piece) => {
    const center = polygonCentroid(piece.polygon);
    const text = `${formatMm(piece.width, state.settings.dimensionDigits)}×${formatMm(piece.height, state.settings.dimensionDigits)}${piece.rectangular ? '' : '*'}${piece.continuation ? ' ↔' : ''}`;
    return `<text x="${(center.x - bbox.minX).toFixed(2)}" y="${mapY(center.y).toFixed(2)}" font-family="Arial, Microsoft JhengHei" font-size="75" text-anchor="middle" dominant-baseline="middle" fill="${piece.smallCut ? '#c5162e' : '#49320f'}" paint-order="stroke" stroke="white" stroke-width="18">${escapeXml(text)}</text>`;
  }).join('\n');
  const title = escapeXml(state.sourceFileName);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height.toFixed(2)}">\n  <defs><pattern id="tileHatch" width="60" height="60" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="60" stroke="#34495e" stroke-opacity=".32" stroke-width="7"/></pattern></defs>\n  <rect width="100%" height="100%" fill="white"/>\n  <g id="separators">${bandSvg}</g>\n  <g id="tile-layout">${pieceSvg}${tileHatchSvg}</g>\n  ${architectureSvg}\n  <g id="regions">${regionSvg}</g>\n  <g id="cut-dimensions">${labelSvg}</g>\n  <text x="40" y="110" font-family="Arial, Microsoft JhengHei" font-size="90" font-weight="700" fill="#182433">${title}</text>\n</svg>`;
  downloadBlob(svg, 'Roof-Tile-Layout.svg', 'image/svg+xml;charset=utf-8');
  toast('SVG 排布圖已輸出。', 'success');
}

function exportDxf() {
  const pieces = (state.layout.pieces || []).filter((piece) => piece.cut || state.settings.showFullTiles);
  if (!pieces.length) return toast('沒有可輸出的排磚結果。', 'warning');
  const roleLayers = mappedLayoutLayerNames();
  const architectureEntities = state.settings.showCad && state.cad
    ? state.cad.entities.filter((entity) => !isLayoutRoleEntity(entity, roleLayers) && entity.type !== 'HATCH')
    : [];
  const dxf = buildRoofTileDxf({
    pieces,
    regions: state.regions,
    bands: state.bands,
    groups: state.groups,
    architectureEntities,
    settings: state.settings,
    sourceFileName: state.sourceFileName
  });
  downloadBlob(dxf, 'Roof-Tile-Layout-Result.dxf', 'application/dxf;charset=utf-8');
  toast(`已輸出可由 AutoCAD 開啟的 DXF：${pieces.length.toLocaleString()} 塊／片，含建築線、磚HATCH、伸縮縫、尺寸及共同起點。`, 'success');
}

function cancelTouchLongPress() {
  if (state.interaction.longPressTimer) clearTimeout(state.interaction.longPressTimer);
  state.interaction.longPressTimer = 0;
  state.interaction.longPressRegionId = null;
  state.interaction.longPressStart = null;
}

function renderTouchSelection() {
  renderRegionList(); renderGroupControls(); renderCutTable(); requestRender();
}

function startTouchMergeSelection(region) {
  if (!region) return;
  selectRegionSelection(region);
  state.touchMergeMode = true;
  renderTouchSelection();
  toast(`已長按選取 ${region.name}；現在可直接點選相鄰區域加入合併。`, 'success');
}

function openTouchActionDialog(region) {
  if (!region) return;
  selectRegionSelection(region);
  renderTouchSelection();
  const members = groupMembers(region.groupId);
  const group = groupById(region.groupId);
  if (!dom.touchActionDialog?.showModal) {
    state.touchMergeMode = true;
    toast(`已選取 ${members.length} 個合併區域；可按「獨立排布」或輸入移動數字。`, 'success');
    return;
  }
  dom.touchActionTitle.textContent = `${group?.name || '合併組'}：${members.length} 個區域`;
  dom.touchActionText.textContent = '已整組高亮。你可以取消合併，或保留合併並進入移動操作。';
  dom.touchActionContinueButton.hidden = true;
  dom.touchActionMoveButton.hidden = false;
  dom.touchActionSplitButton.hidden = false;
  dom.touchActionDialog.showModal();
}

function handleTouchLongPress(region) {
  if (!region) return;
  state.interaction.longPress = true;
  state.interaction.moved = true;
  const merged = groupMembers(region.groupId).length > 1;
  if (merged) openTouchActionDialog(region);
  else startTouchMergeSelection(region);
}

function scheduleTouchLongPress(region, startPoint, { list = false } = {}) {
  if (!region || !isCoarsePointerDevice()) return;
  cancelTouchLongPress();
  state.interaction.longPressRegionId = region.id;
  state.interaction.longPressStart = startPoint || null;
  state.interaction.longPressTimer = setTimeout(() => {
    state.interaction.longPressTimer = 0;
    state.interaction.longPressStart = null;
    if (list) state.interaction.suppressTouchClick = true;
    handleTouchLongPress(region);
  }, 480);
}

function handleRegionListPointerDown(event) {
  if (event.pointerType !== 'touch') return;
  const row = event.target.closest('.region-row');
  const region = row ? regionById(row.dataset.regionId) : null;
  if (!region) return;
  scheduleTouchLongPress(region, { x: event.clientX, y: event.clientY }, { list: true });
}

function handleRegionListPointerMove(event) {
  if (event.pointerType !== 'touch' || !state.interaction.longPressStart) return;
  const start = state.interaction.longPressStart;
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancelTouchLongPress();
}

function handleRegionListPointerUp(event) {
  if (event.pointerType === 'touch') cancelTouchLongPress();
}

function handleRegionListClick(event) {
  const row = event.target.closest('.region-row');
  if (!row) return;
  // A long press normally produces a follow-up native click whose MouseEvent
  // has no pointerType. Consume it regardless of pointerType so it cannot
  // undo or re-toggle the selection created by the long press.
  if (state.interaction.suppressTouchClick) {
    state.interaction.suppressTouchClick = false;
    event.preventDefault();
    return;
  }
  const id = row.dataset.regionId;
  const region = regionById(id);
  if (!region) return;
  const checkbox = row.querySelector('input[type="checkbox"]');
  const modifierMulti = event.shiftKey || event.ctrlKey || event.metaKey;
  const touchMulti = isCoarsePointerDevice() && state.touchMergeMode;
  const merged = groupMembers(region.groupId).length > 1;
  if (event.target === checkbox && !modifierMulti && !touchMulti && !merged) {
    if (checkbox.checked) state.selection.add(id); else state.selection.delete(id);
    state.activeRegionId = id;
    state.activeGroupId = region.groupId;
  } else {
    selectRegionSelection(region, {
      multi: modifierMulti || touchMulti,
      toggle: modifierMulti && !touchMulti
    });
  }
  renderRegionList(); renderGroupControls(); renderCutTable(); requestRender();
  if (event.detail === 2) zoomToRegion(regionById(id));
}

function handleBandListClick(event) {
  const row = event.target.closest('.band-row');
  if (!row) return;
  const band = state.bands.find((item) => item.id === row.dataset.bandId);
  if (!band) return;
  if (event.target.matches('input[type="checkbox"]')) {
    band.enabled = event.target.checked; scheduleLayout();
  } else if (event.target.closest('.band-delete')) {
    pushHistory(); state.bands = state.bands.filter((item) => item.id !== band.id); renderBandList(); scheduleLayout();
  }
}



function rebuildRegionsFromHatches() {
  if (!state.cad || !state.layerMapping.region) return 0;
  const result = hatchComponentsFromLayer(state.cad, state.layerMapping.region);
  const components = [...(result.components || [])];
  if (!components.length) {
    state.sourceRegionCount = 0;
    return 0;
  }

  // Preserve the original HATCH ordering so familiar labels remain stable.
  components.sort((a, b) => {
    const boxA = bboxOfPoints(a.polygon);
    const boxB = bboxOfPoints(b.polygon);
    return boxB.maxY - boxA.maxY || boxA.minX - boxB.minX || boxB.height - boxA.height;
  });

  const detectedJoints = detectExpansionJointBands(state.cad);
  const splitComponents = splitHatchComponentsByBands(components, detectedJoints);
  state.sourceRegionCount = splitComponents.length;

  state.regions = [];
  state.groups = [];
  state.bands = detectedJoints.map((band) => ({ ...band, global: true, enabled: true, visible: true }));
  const colors = ['#0b6bcb', '#7a49a5', '#0c8b77', '#a06a13', '#a13454'];
  for (let index = 0; index < splitComponents.length; index += 1) {
    const component = splitComponents[index];
    const baseNumber = component.baseIndex + 1;
    const suffix = component.splitCount > 1 ? `-${String.fromCharCode(65 + component.splitIndex)}` : '';
    const displayNumber = `${String(baseNumber).padStart(2, '0')}${suffix}`;
    const polygon = cleanPolygon(component.polygon);
    const holes = (component.holes || []).map((hole) => cleanPolygon(hole));
    const bbox = bboxOfPoints(polygon);
    const rotation = bbox.width >= bbox.height ? 0 : 90;
    const regionId = `region-${String(baseNumber).padStart(3, '0')}${suffix || ''}`;
    const groupId = `group-${String(baseNumber).padStart(3, '0')}${suffix || ''}`;
    const removedKey = hatchRegionKey(component);
    if (state.removedHatchKeys.has(removedKey)) continue;
    state.regions.push({
      id: regionId,
      name: `區域 ${displayNumber}`,
      baseRegionNumber: baseNumber,
      splitIndex: component.splitIndex,
      splitCount: component.splitCount,
      polygon,
      holes,
      bbox,
      rotation,
      groupId,
      originX: bbox.minX,
      originY: bbox.minY,
      offsetX: 0, offsetY: 0, up: 0, down: 0, left: 0, right: 0,
      approximate: false,
      sourceHandle: component.sourceHandle,
      sourceLayer: component.sourceLayer,
      sourcePattern: component.sourcePattern,
      sourcePathIndex: component.sourcePathIndex,
      hatchRegionKey: removedKey,
      splitByJointIds: component.splitByJointIds || [],
      enabled: true
    });
    state.groups.push({
      ...createGroup(groupId, `區域 ${displayNumber} 獨立`, bbox.minX, bbox.minY, colors[index % colors.length]),
      anchorRegionId: regionId
    });
  }

  state.hatchObjectCount = result.hatches?.length || 0;
  state.hatchHoleCount = result.holeCount || 0;
  state.removedOverlapRegions = result.removedContainedCount || 0;
  state.baseRegionCount = components.length;
  state.splitRegionCount = state.regions.length;
  state.detectedJointCount = detectedJoints.length;
  state.exactCount = state.regions.length;
  state.sourceMode = 'hatch';
  state.activeRegionId = state.regions[0]?.id || null;
  state.activeGroupId = state.regions[0]?.groupId || null;
  state.selection = new Set(state.activeRegionId ? [state.activeRegionId] : []);
  state.touchMergeMode = false;
  return state.regions.length;
}

function enterCadPickMode(reason = '') {
  state.qa = null;
  state.sourceRegionCount = 0;
  state.removedHatchKeys = new Set();
  state.regions = [];
  state.groups = [];
  state.bands = [];
  state.layerMapping.region = '';
  state.activeRegionId = null;
  state.activeGroupId = null;
  state.selection = new Set();
  state.touchMergeMode = false;
  state.exactCount = 0;
  state.baseRegionCount = 0;
  state.splitRegionCount = 0;
  state.detectedJointCount = 0;
  state.hatchObjectCount = 0;
  state.hatchHoleCount = 0;
  state.sourceMode = 'cad-pick';
  setSourceBadge('CAD 取區', 'preview');
  setNotice(`這份圖紙沒有可直接使用的鋪磚 HATCH。請按「CAD取區」，點選任意閉合多段線、圓／橢圓，或點入閉合區域${reason ? `（${reason.split('\n')[0]}）` : ''}。取區後可合併、設定起點並排布。`, 'warning');
  dom.sourceDetail.textContent = `${state.cad?.entities?.length || 0} 個可繪實體 · 等待 CAD 取區`;
  renderAllControls();
  scheduleLayout();
  fitView();
}

async function loadCadBuffer(arrayBuffer, fileName, {
  initial = false,
  restoreAuto = true,
  activateProject = true,
  skipProjectPersist = false,
  forceNewProject = false,
  projectName = ''
} = {}) {
  try {
    if (!initial && !skipProjectPersist) await persistActiveProject({ includeSource: true, sync: false });
    const sourceFormat = String(fileName).toLowerCase().endsWith('.dxf') ? 'DXF' : 'DWG';
    state.sourceDxfText = sourceFormat === 'DXF' ? new TextDecoder('utf-8').decode(arrayBuffer) : '';
    state.sourceSyncId = '';
    setSourceBadge(`${sourceFormat} 解析中`, 'loading');
    dom.calculationBadge.textContent = '解析 CAD'; dom.calculationBadge.className = 'calculation-badge busy';
    const cad = await parseCadFile(arrayBuffer, fileName, (message) => { dom.sourceDetail.textContent = message; });
    state.cad = cad;
    state.sourceFileName = fileName;
    state.removedHatchKeys = new Set();
    state.sourceRegionCount = 0;
    state.layerMapping.region = inferAreaHatchLayer(cad);
    const regionCount = rebuildRegionsFromHatches();
    if (!regionCount && !state.sourceRegionCount) throw new Error('所選圖層沒有可用的 HATCH 鋪磚區域。');
    if (restoreAuto) restoreAutoProjectIfCompatible(fileName);
    if (activateProject) {
      const activated = await activateProjectForCurrentSource({ forceNew: forceNewProject, name: projectName, restoreExisting: !forceNewProject });
      if (!activated) toast(`已達 project 上限 ${PROJECT_MAX_COUNT} 個；目前圖紙尚未加入 project 庫。`, 'warning');
    }
    setSourceBadge('HATCH 精確區域', 'exact');
    const layerNote = normalizedLayerName(state.layerMapping.region) === 'ROOF TILE'
      ? ''
      : ` 本檔的標定 HATCH 實體實際儲存在「${state.layerMapping.region}」圖層；「Roof tile」圖層是線條，沒有 HATCH。`;
    setNotice(`已讀取 ${state.hatchObjectCount} 個鋪磚 HATCH：${state.baseRegionCount} 個原區經 ${state.detectedJointCount} 條有效20 mm伸縮縫切成 ${regionCount} 個最小倉，保留 ${state.hatchHoleCount} 個孔洞${state.removedOverlapRegions ? `，忽略 ${state.removedOverlapRegions} 個完全重疊子區` : ''}。${layerNote} 合併後只共享起點與錯縫模數，不合併幾何。`, 'success');
    dom.sourceDetail.textContent = `${state.hatchObjectCount} HATCH · ${state.baseRegionCount} 原區 → ${regionCount} 最小倉 · ${state.detectedJointCount} 條20mm縫 · ${state.hatchHoleCount} 孔洞`;
    renderAllControls(); scheduleLayout(); fitView();
    toast(`已從 HATCH 建立 ${regionCount} 個鋪磚區域。`, 'success');
  } catch (error) {
    console.error(error);
    if (!initial && state.cad) {
      enterCadPickMode(error.message);
      if (activateProject) {
        const activated = await activateProjectForCurrentSource({ forceNew: forceNewProject, name: projectName, restoreExisting: !forceNewProject });
        if (!activated) toast(`已達 project 上限 ${PROJECT_MAX_COUNT} 個；目前圖紙尚未加入 project 庫。`, 'warning');
      }
      renderProjectControls();
      toast('未找到可直接分區的 HATCH，已切換至 CAD 取區模式。', 'success');
      return;
    }
    state.sourceMode = 'preview';
    setSourceBadge('QA 預覽', 'preview');
    setNotice(`HATCH 區域讀取未完成：${error.message.split('\n')[0]}。目前仍可用 QA 預覽或在「圖層」內重選 HATCH 圖層。`, 'warning');
    dom.sourceDetail.textContent = initial ? '內置 HATCH DXF 未完成 · QA 預覽可用' : 'CAD 解析失敗';
    dom.calculationBadge.textContent = 'QA 預覽'; dom.calculationBadge.className = 'calculation-badge done';
    if (!initial) toast(error.message.split('\n')[0], 'error');
    renderAllControls();
  }
}

function applyLayerMapping() {
  if (!state.cad) return toast('請先開啟 DWG / DXF。', 'warning');
  pushHistory();
  state.layerMapping.region = dom.regionLayerSelect.value;
  const regionCount = rebuildRegionsFromHatches();
  if (!regionCount && !state.sourceRegionCount) return toast('所選圖層沒有可用 HATCH。', 'warning');
  setSourceBadge('HATCH 精確區域', 'exact');
  setNotice(`已由「${state.layerMapping.region}」的 ${state.hatchObjectCount} 個 HATCH建立 ${state.baseRegionCount} 個原區，再按 ${state.detectedJointCount} 條嚴格標定20 mm伸縮縫切成 ${regionCount} 個最小倉${state.removedOverlapRegions ? `；忽略 ${state.removedOverlapRegions} 個重疊子區` : ''}。`, 'success');
  dom.layerDialog.close();
  renderAllControls(); scheduleLayout(); fitView();
}

function bindEvents() {
  const settingsInputs = [dom.tileLongInput, dom.tileShortInput, dom.jointXInput, dom.jointYInput, dom.staggerEnabledInput, dom.staggerOffsetInput, dom.minCutInput, dom.dimensionDigitsInput, dom.showFullTilesInput, dom.showCutLabelsInput, dom.showCadInput, dom.keepArchitectureInput];
  for (const input of settingsInputs.filter(Boolean)) input.addEventListener('input', () => { readSettingsInputs(); scheduleLayout(); });
  dom.resetTileSettings.addEventListener('click', () => { pushHistory(); state.settings = { ...DEFAULT_SETTINGS }; syncSettingsInputs(); renderGroupControls(); scheduleLayout(); });
  dom.openCadButton.addEventListener('click', () => {
    state.pendingProjectName = '';
    dom.cadFileInput.click();
  });
  dom.newProjectButton.addEventListener('click', () => {
    if (state.projectCatalog.length >= PROJECT_MAX_COUNT) {
      toast(`最多保存 ${PROJECT_MAX_COUNT} 個 project；請先刪除舊 project。`, 'warning');
      return;
    }
    const name = window.prompt('請先輸入新 project 名稱，然後選擇 DWG／DXF 圖紙。', `Project ${state.projectCatalog.length + 1}`)?.trim();
    if (!name) return;
    state.pendingProjectName = name;
    dom.cadFileInput.click();
  });
  dom.cadFileInput.addEventListener('change', async () => {
    const file = dom.cadFileInput.files?.[0]; if (!file) return;
    const projectName = state.pendingProjectName;
    state.pendingProjectName = '';
    await loadCadBuffer(await file.arrayBuffer(), file.name, {
      forceNewProject: Boolean(projectName),
      projectName
    });
    dom.cadFileInput.value = '';
  });
  dom.projectSelect.addEventListener('change', () => {
    if (dom.projectSelect.value) void switchProject(dom.projectSelect.value);
  });
  dom.renameProjectButton.addEventListener('click', () => { void renameCurrentProject(); });
  dom.deleteProjectButton.addEventListener('click', () => { void deleteCurrentProject(); });
  dom.exportProjectButton.addEventListener('click', exportProjectBackup);
  dom.importProjectButton.addEventListener('click', () => dom.projectFileInput.click());
  dom.projectFileInput.addEventListener('change', async () => {
    const file = dom.projectFileInput.files?.[0];
    await importProjectBackup(file);
  });
  dom.syncKeyInput.addEventListener('input', () => rememberSyncKey(dom.syncKeyInput.value));
  dom.uploadSyncButton.addEventListener('click', () => { void uploadSync(); });
  dom.downloadSyncButton.addEventListener('click', () => { void downloadSync(); });
  dom.exportCsvButton.addEventListener('click', exportCutCsv);
  dom.exportSvgButton.addEventListener('click', exportSvg);
  dom.exportDxfButton.addEventListener('click', exportDxf);
  dom.printButton.addEventListener('click', () => window.print());
  dom.helpButton.addEventListener('click', () => dom.helpDialog.showModal());
  dom.layerMappingButton.addEventListener('click', () => { renderLayerDialog(); dom.layerDialog.showModal(); });
  dom.applyLayerMappingButton.addEventListener('click', (event) => { event.preventDefault(); applyLayerMapping(); dom.layerDialog.close(); });

  dom.mergeRegionsButton.addEventListener('click', mergeSelectedRegions);
  dom.splitRegionsButton.addEventListener('click', splitSelectedRegions);
  dom.deleteRegionButton.addEventListener('click', deleteSelectedManualRegions);
  dom.removeHatchButton.addEventListener('click', removeSelectedHatchRegions);
  dom.saveNamedVersionButton.addEventListener('click', saveNamedVersion);
  dom.loadNamedVersionButton.addEventListener('click', loadNamedVersion);
  dom.deleteNamedVersionButton.addEventListener('click', deleteNamedVersion);
  dom.savedVersionSelect.addEventListener('change', renderNamedVersions);
  if (typeof dom.splitRegionsButton.setAttribute === 'function') {
    dom.splitRegionsButton.setAttribute('aria-label', '取消合併 / 獨立排布');
  }
  dom.splitRegionsButton.title = '取消合併：把目前選取的持續合併組恢復為獨立排布';

  dom.touchActionContinueButton.addEventListener('click', () => {
    state.touchMergeMode = true;
    dom.touchActionDialog.close();
    renderRegionList();
    toast('觸控合併模式已開啟；直接點選相鄰區域加入高亮。', 'success');
  });
  dom.touchActionMoveButton.addEventListener('click', () => {
    state.touchMergeMode = false;
    dom.touchActionDialog.close();
    dom.nudgeUpInput.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    dom.nudgeUpInput.focus?.();
    toast('已選取整個合併組；請輸入移動數字或按四向按鈕。', 'success');
  });
  dom.touchActionSplitButton.addEventListener('click', () => {
    dom.touchActionDialog.close();
    splitSelectedRegions();
  });

  dom.activeGroupSelect.addEventListener('change', () => {
    state.activeGroupId = dom.activeGroupSelect.value;
    const first = groupMembers(state.activeGroupId)[0];
    if (first) { state.activeRegionId = first.id; state.selection = new Set([first.id]); }
    renderRegionList(); renderGroupControls(); renderCutTable(); requestRender();
  });
  dom.unifiedOriginInput.addEventListener('change', () => { const group = activeGroup(); if (!group) return; pushHistory(); group.unifiedOrigin = dom.unifiedOriginInput.checked; renderGroupControls(); scheduleLayout(); });
  dom.carryAcrossInput.addEventListener('change', () => { const group = activeGroup(); if (!group) return; pushHistory(); group.carryAcross = dom.carryAcrossInput.checked; scheduleLayout(); });
  for (const input of [dom.originXInput, dom.originYInput, dom.nudgeUpInput, dom.nudgeDownInput, dom.nudgeLeftInput, dom.nudgeRightInput]) input.addEventListener('input', updateOriginInputs);
  dom.confirmMoveButton.addEventListener('click', commitMoveInputs);
  for (const input of [dom.nudgeUpInput, dom.nudgeDownInput, dom.nudgeLeftInput, dom.nudgeRightInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commitMoveInputs();
    });
  }
  const nudgeByButton = (dx, dy) => {
    const step = Math.max(1, Math.round(numeric(dom.nudgeStepInput, 1)));
    nudgeActiveOrigin(dx * step, dy * step);
  };
  const bindNudgeButton = (button, dx, dy) => {
    let holdTimer = 0;
    let repeatTimer = 0;
    let held = false;
    const stop = () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (repeatTimer) clearInterval(repeatTimer);
      holdTimer = 0;
      repeatTimer = 0;
    };
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      held = false;
      holdTimer = setTimeout(() => {
        held = true;
        repeatTimer = setInterval(() => nudgeByButton(dx, dy), 110);
      }, 350);
    });
    button.addEventListener('pointerup', stop);
    button.addEventListener('pointercancel', stop);
    button.addEventListener('pointerleave', stop);
    button.addEventListener('click', () => {
      if (held) { held = false; return; }
      nudgeByButton(dx, dy);
    });
  };
  bindNudgeButton(dom.nudgeButtonUp, 0, 1);
  bindNudgeButton(dom.nudgeButtonDown, 0, -1);
  bindNudgeButton(dom.nudgeButtonLeft, -1, 0);
  bindNudgeButton(dom.nudgeButtonRight, 1, 0);
  dom.optimizeOriginButton.addEventListener('click', optimizeActiveOrigin);
  dom.selectedOrientationInput.addEventListener('change', changeSelectedOrientation);
  dom.rotateSelectedButton.addEventListener('click', rotateSelectedRegions);

  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  dom.fitViewButton.addEventListener('click', () => fitView());
  dom.zoomSelectionButton.addEventListener('click', zoomToSelection);
  dom.undoButton.addEventListener('click', undo);
  dom.autoDetectBandsButton.addEventListener('click', autoDetectBands);
  document.querySelectorAll('[data-band-width]').forEach((button) => button.addEventListener('click', () => { dom.bandWidthInput.value = button.dataset.bandWidth; dom.bandTypeInput.value = button.dataset.bandType; setMode('band'); }));
  dom.bandList.addEventListener('click', handleBandListClick);

  for (const input of [dom.cutSelectedOnlyInput, dom.cutSmallOnlyInput, dom.cutSearchInput]) input.addEventListener('input', renderCutTable);
  dom.cutTableBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-region-id]'); if (!row) return;
    const region = regionById(row.dataset.regionId); if (!region) return;
    state.selection = new Set([region.id]); state.activeRegionId = region.id; state.activeGroupId = region.groupId;
    renderRegionList(); renderGroupControls(); renderCutTable(); zoomToRegion(region);
  });

  dom.layoutCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
  dom.layoutCanvas.addEventListener('pointermove', handleCanvasPointerMove);
  dom.layoutCanvas.addEventListener('pointerup', handleCanvasPointerUp);
  dom.layoutCanvas.addEventListener('pointercancel', handleCanvasPointerUp);
  dom.layoutCanvas.addEventListener('wheel', handleCanvasWheel, { passive: false });
  dom.layoutCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
  dom.layoutCanvas.addEventListener('mouseleave', () => { if (!state.interaction.dragging) dom.canvasTooltip.hidden = true; });

  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
    const key = event.key.toLowerCase();
    if (key === 'v') setMode('select');
    else if (key === 'h') setMode('pan');
    else if (key === 'o') setMode('origin');
    else if (key === 'b') setMode('band');
    else if (key === 'a') setMode('pickRegion');
    else if (key === 'f') fitView();
    else if (key === 'r') rotateSelectedRegions();
    else if (['arrowup','arrowdown','arrowleft','arrowright'].includes(key)) {
      event.preventDefault();
      const step = Math.max(1, Math.round(numeric(dom.nudgeStepInput, 1))) * (event.shiftKey ? 10 : 1);
      if (key === 'arrowup') nudgeActiveOrigin(0, step);
      if (key === 'arrowdown') nudgeActiveOrigin(0, -step);
      if (key === 'arrowleft') nudgeActiveOrigin(-step, 0);
      if (key === 'arrowright') nudgeActiveOrigin(step, 0);
    }
  });
  new ResizeObserver(() => requestRender()).observe(dom.canvasFrame);
}

async function initialize() {
  bindEvents();
  await loadProjectCatalog();
  const savedSyncKey = readSyncKey();
  rememberSyncKey(savedSyncKey);
  setSyncStatus(savedSyncKey ? '已保存同步碼' : '未設定同步碼');
  syncSettingsInputs();
  dom.undoButton.disabled = true;
  setMode('select');
  try {
    const qaResponse = await fetch('data/Roof Tile - Layout QA.json');
    if (!qaResponse.ok) throw new Error(`QA ${qaResponse.status}`);
    applyQA(await qaResponse.json());
    state.initialized = true;
  } catch (error) {
    console.error(error);
    setSourceBadge('需啟動伺服器', 'error');
    setNotice('無法載入內置 QA 資料。請用 start.bat 啟動，不要直接雙擊 index.html；也可手動開啟 DWG / DXF。', 'error');
    toast('請使用 start.bat 啟動網頁。', 'error');
    renderAllControls(); fitView();
    return;
  }
  window.__roofTileApp = {
    state,
    recalculate: calculateLayout,
    snapshot: () => snapshotProject(),
    restore: (project) => restoreProject(project, true),
    selectRegionIds: (ids = []) => {
      const valid = new Set(ids.filter((id) => regionById(id)));
      state.selection = valid;
      const first = state.regions.find((region) => valid.has(region.id));
      if (first) { state.activeRegionId = first.id; state.activeGroupId = first.groupId; }
      renderRegionList(); renderGroupControls(); renderCutTable(); requestRender();
      return [...valid];
    },
    mergeSelection: () => mergeSelectedRegions(),
    splitSelection: () => splitSelectedRegions(),
    deleteManualSelection: () => deleteSelectedManualRegions(),
    removeHatchSelection: () => removeSelectedHatchRegions(),
    selectByScreenBox: (start, end, options = {}) => selectRegionsByScreenBox(start, end, options),
    undo: () => undo(),
    saveNamedVersion: () => saveNamedVersion(),
    loadNamedVersion: () => loadNamedVersion(),
    deleteNamedVersion: () => deleteNamedVersion(),
    switchProject: (id) => switchProject(id),
    renameProject: () => renameCurrentProject(),
    deleteProject: () => deleteCurrentProject(),
    projectCatalog: () => cloneProjectData(state.projectCatalog),
    setGroupOrigin: (x, y) => setOriginAt({ x: Number(x), y: Number(y) }),
    nudgeOrigin: (dx, dy) => nudgeActiveOrigin(Number(dx), Number(dy)),
    snapPoint: (point) => snapToExistingGeometry({ x: Number(point.x), y: Number(point.y) }),
    zoomToBaseRegion: (number) => {
      const matches = state.regions.filter((region) => region.baseRegionNumber === Number(number));
      if (matches.length) fitView(matches);
      return matches.map((region) => region.id);
    },
    buildDxf: () => buildRoofTileDxf({
      pieces: (state.layout.pieces || []).filter((piece) => piece.cut || state.settings.showFullTiles),
      regions: state.regions,
      bands: state.bands,
      groups: state.groups,
      architectureEntities: state.settings.showCad && state.cad
        ? state.cad.entities.filter((entity) => !isLayoutRoleEntity(entity, mappedLayoutLayerNames()) && entity.type !== 'HATCH')
        : [],
      settings: state.settings,
      sourceFileName: state.sourceFileName
    }),
    setOrientation: (rotation) => { dom.selectedOrientationInput.value = String(normalizeRotation(rotation)); changeSelectedOrientation(); },
    rotateSelection: () => rotateSelectedRegions()
  };
  const query = new URLSearchParams(window.location.search);
  if (query.has('skipCad') || query.has('skipDwg')) {
    dom.sourceDetail.textContent = 'QA 預覽測試模式';
    return;
  }
  try {
    const dxfResponse = await fetch('data/roof tile with area hatched.dxf');
    if (!dxfResponse.ok) throw new Error(`DXF ${dxfResponse.status}`);
    await loadCadBuffer(await dxfResponse.arrayBuffer(), 'roof tile with area hatched.dxf', { initial: true });
  } catch (error) {
    console.error(error);
    setNotice('內置 HATCH DXF 未能自動載入；QA 後備區域仍可使用，也可按「開啟 DWG / DXF」重試。', 'warning');
  }
}

initialize();
