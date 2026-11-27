import { cents, decimalSum, halfUp, squareMetres } from '../engineering/decimal.js';
import { geoJsonToJsts, type JstsGeometry } from '../geo/geojson-to-jsts.js';
import { polygonArea } from './index.js';
import { projectGeometryPath } from './project-input.js';

export const PROPERTY_AREA_PATH = 'property_area.json';
export const SHANGHAI_PROFILE = 'sh-property-2022-single-building';
export const SHANGHAI_RULE = '沪房市场〔2022〕49号；附件 1.2.1、1.2.2、3.3.1、3.3.2、3.3.3（1）';
type TextReader = (path: string) => Promise<string | null | undefined> | string | null | undefined;
type Basis = 'building-perimeter' | 'unit-wall-centerline' | 'unit-usable' | 'unit-wall-share' |
  'balcony-perimeter' | 'balcony-eligible-footprint' | 'common-wall-centerline' | 'outer-half-wall' | 'deduction';
type Measurement = { id: string; source: string; basis: Basis } &
  ({ areaM2: number; geometry?: never } | { geometry: { level: string; id: string }; areaM2?: never });
type UnitPart = Measurement & { treatment?: 'enclosed' | 'open-eligible' | 'excluded' };
export interface ShanghaiPropertyPlan {
  version: 1;
  profile: typeof SHANGHAI_PROFILE;
  modelRevision: string;
  building: { id: string; parcelId: string; scope: 'whole-residential-building'; source: string };
  business: { type: 'new-survey'; measuredOn: string; source: string };
  review: { confirmed: boolean; source: string };
  frame?: string;
  gross: Measurement;
  units: { id: string; ownershipSource: string; parts: UnitPart[] }[];
  deductions: (Measurement & { kind: 'independent-use' | 'non-allocatable' })[];
  common: { scope: 'whole-building'; source: string; beneficiaryUnitIds: string[];
    parts: Measurement[] };
}

const tool = 'shanghai-single-building-allocation@1';
const hasText = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const scales = new Map(Object.entries({ m: 1, mm: 0.001, ft: 0.3048, in: 0.0254 }));
const tolerance = 0.000001;
type DiagnosticKind = 'missing-data' | 'needs-review' | 'unsupported' | 'conflict' | 'invalid';
class EvidenceError extends Error {
  constructor(readonly kind: DiagnosticKind, readonly field: string, message: string) { super(message); }
}
function requireEvidence(condition: unknown, kind: DiagnosticKind, field: string, message: string): asserts condition {
  if (!condition) throw new EvidenceError(kind, field, message);
}

function adoptedDate(date: unknown) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(date);
  return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === date && date >= '2022-07-01';
}

const base = { tool, ruleSource: SHANGHAI_RULE, unit: 'm2' };

async function bindShanghaiPropertyArea(text: TextReader, planText: string | undefined, approval?: { confirmed: boolean }) {
  let modelRevision: string | undefined;
  try {
    const metadataText = await text('project_metadata.json');
    requireEvidence(metadataText, 'missing-data', 'project_metadata.json', '缺少 BIMDown 项目元数据。');
    const metadata = JSON.parse(metadataText);
    modelRevision = hasText(metadata?.engineering_revision) ? metadata.engineering_revision : undefined;
    const raw = planText ?? await text(PROPERTY_AREA_PATH);
    if (!raw?.trim()) return { ...base, status: 'input-incomplete' as const,
      modelRevision,
      diagnostics: [
        { kind: 'missing-data', field: PROPERTY_AREA_PATH, message: '缺少有来源的测算任务和已确认规则版本。' },
        { kind: 'missing-data', field: 'gross / units', message: '补独立核定的幢总量、权属单元及已复核套内边界或量测分项。' },
        { kind: 'missing-data', field: 'common / deductions', message: '补共有台账、独立空间扣除及全幢受益范围依据。' },
      ] };
    const plan = JSON.parse(raw) as ShanghaiPropertyPlan | null;
    requireEvidence(plan?.version === 1 && plan.profile === SHANGHAI_PROFILE,
      'unsupported', 'version / profile', '本入口支持上海 2022 版单幢居住差额法的 version 1 证据。');
    requireEvidence(String(metadata?.format_version) === '2' && hasText(metadata?.engineering_revision) &&
      metadata.engineering_revision === plan.modelRevision,
    'conflict', 'modelRevision', '测算证据须与当前 BIMDown 导出版本匹配。');
    requireEvidence(plan.business?.type === 'new-survey' && adoptedDate(plan.business.measuredOn) && hasText(plan.business.source),
      'unsupported', 'business', '本入口需要有业务依据的 2022-07-01 起适用的新测算。历史预测、原成果纠错、登记变更及改扩建需另核。');
    requireEvidence(plan.building?.scope === 'whole-residential-building' &&
      [plan.building.id, plan.building.parcelId, plan.building.source].every(hasText),
    'needs-review', 'building', '请确认单宗地单幢住宅的全幢范围及来源。');
    if (approval) {
      requireEvidence(approval.confirmed && plan.review?.confirmed === true && hasText(plan.review.source),
        'needs-review', 'review', '请确认测算依据、分项和权属范围，并记录复核来源。');
    }
    requireEvidence(Array.isArray(plan.units) && plan.units.length > 0 && plan.units.length <= 2_000 &&
      Array.isArray(plan.deductions) && Array.isArray(plan.common?.parts),
    'missing-data', 'units / deductions / common', '套内、扣除项和共有台账须完整列出。');
    const unitIds = new Set<string>();
    for (const unit of plan.units) {
      requireEvidence(unit && hasText(unit.id) && !unitIds.has(unit.id) && hasText(unit.ownershipSource) &&
        Array.isArray(unit.parts) && unit.parts.length > 0,
      'invalid', 'units', '权属单元须有唯一 ID、产权来源和完整套内分项。');
      unitIds.add(unit.id);
    }
    requireEvidence(plan.common.scope === 'whole-building' && hasText(plan.common.source) &&
      Array.isArray(plan.common.beneficiaryUnitIds) && plan.common.beneficiaryUnitIds.length === unitIds.size &&
      new Set(plan.common.beneficiaryUnitIds).size === unitIds.size && plan.common.beneficiaryUnitIds.every(id => unitIds.has(id)),
    'conflict', 'common.beneficiaryUnitIds', '共有台账须经确认由本幢全部权属单元按套内面积受益。');
    const totalParts = plan.units.reduce((sum, unit) => sum + unit.parts.length, 0) + plan.common.parts.length + plan.deductions.length;
    requireEvidence(totalParts <= 2_000, 'unsupported', 'parts', '单次测算最多支持 2,000 个分项。');

    const used = new Set<string>();
    const usedGeometry = new Set<string>();
    const geometryByLevel = new Map<string, { id: string; polygon: JstsGeometry }[]>();
    const collections = new Map<string, Map<string, unknown[]>>();
    async function measure(item: Measurement, allowed: readonly Basis[], field: string) {
      requireEvidence(item && hasText(item.id) && !used.has(item.id) && hasText(item.source) && allowed.includes(item.basis),
        'conflict', field, '分项 ID 重复、缺少来源或测量边界口径不匹配。');
      used.add(item.id);
      requireEvidence((item.areaM2 === undefined) !== (item.geometry === undefined),
        'invalid', item.id, '每个分项须选用一种证据，已复核面积或已复核产权轮廓。');
      if (!item.geometry) {
        requireEvidence(typeof item.areaM2 === 'number' && Number.isFinite(item.areaM2) && item.areaM2 >= 0 && item.areaM2 <= 1e9,
          'invalid', item.id, '复核面积须为有效非负平方米数。');
        return { id: item.id, basis: item.basis, source: item.source, rawArea: item.areaM2 };
      }
      requireEvidence(item !== plan!.gross && hasText(plan!.frame) && hasText(item.geometry.id),
        'needs-review', item.id, '幢总量须独立复核录入。分项轮廓须有 ID 和共同坐标基准。');
      const scale = scales.get(metadata.units);
      requireEvidence(scale !== undefined, 'invalid', item.id, '项目缺少支持的平面坐标单位。');
      const { level, id } = item.geometry;
      const path = projectGeometryPath({ level, table: 'property_boundary' });
      const key = JSON.stringify([level, id]);
      requireEvidence(!usedGeometry.has(key), 'conflict', item.id, '同一产权轮廓被重复计量。');
      usedGeometry.add(key);
      if (!collections.has(path)) {
        const raw = await text(path);
        requireEvidence(raw, 'missing-data', path, '缺少本层已审核的产权测算轮廓。');
        const geojson = JSON.parse(raw);
        requireEvidence(geojson?.type === 'FeatureCollection' && Array.isArray(geojson.features),
          'invalid', path, '产权轮廓须为 GeoJSON FeatureCollection。');
        requireEvidence(geojson.modelRevision === modelRevision,
          'conflict', path, '产权轮廓与当前 BIMDown 导出版本不匹配。');
        const index = new Map<string, unknown[]>();
        for (const feature of geojson.features) {
          const id = feature?.properties?.id;
          if (typeof id === 'string') index.set(id, [...(index.get(id) ?? []), feature]);
        }
        collections.set(path, index);
      }
      const matches = collections.get(path)!.get(id);
      const feature = matches?.[0] as { geometry?: { type?: unknown; coordinates?: unknown };
        properties?: { frame?: unknown; boundary_basis?: unknown; reviewed?: unknown; source?: unknown } } | undefined;
      requireEvidence(matches?.length === 1 && feature?.geometry?.type === 'Polygon' &&
        feature.properties?.frame === plan!.frame && feature.properties.boundary_basis === item.basis &&
        feature.properties.reviewed === true && hasText(feature.properties.source),
      'conflict', `${path} · ${id}`, '轮廓须唯一、已复核且口径与坐标系一致。');
      const rings = (feature.geometry.coordinates as number[][][]).map(ring =>
        ring.map(point => point.map(value => typeof value === 'number' ? value * scale : Number.NaN)));
      const origin = rings[0]?.[0];
      requireEvidence(origin?.length === 2, 'invalid', item.id, '产权轮廓缺少二维外环。');
      const rawArea = polygonArea(rings.map(ring => ring.map(point => point.map((coordinate, axis) => coordinate - origin[axis]))));
      const polygon = geoJsonToJsts({ type: 'Polygon', coordinates: rings as [number, number][][] });
      requireEvidence(polygon && polygon.isValid() && Number.isFinite(rawArea) && rawArea <= 1e9,
        'invalid', item.id, '产权轮廓自交、洞口无效或面积超出范围。');
      const previous = geometryByLevel.get(level) ?? [];
      for (const other of previous) {
        if (!other.polygon.intersects(polygon)) continue;
        const overlap = other.polygon.intersection(polygon) as JstsGeometry & { getArea(): number };
        requireEvidence(overlap.getArea() <= tolerance, 'conflict', item.id, `与分项 ${other.id} 存在正面积重叠。`);
      }
      previous.push({ id: item.id, polygon });
      geometryByLevel.set(level, previous);
      return { id: item.id, basis: item.basis, source: item.source, rawArea,
        geometry: { level, id, path, frame: plan!.frame, source: feature.properties.source } };
    }

    const gross = await measure(plan.gross, ['building-perimeter'], 'gross');
    requireEvidence(gross.rawArea > 0, 'invalid', 'gross', '独立核定幢总面积须为正。');
    const units = [];
    for (const unit of plan.units) {
      const core = unit.parts.filter(part => part?.basis !== 'balcony-perimeter' && part?.basis !== 'balcony-eligible-footprint');
      const centerline = core.some(part => part?.basis === 'unit-wall-centerline');
      requireEvidence(centerline ? core.every(part => part?.basis === 'unit-wall-centerline')
        : core.some(part => part?.basis === 'unit-usable') && core.some(part => part?.basis === 'unit-wall-share') &&
          core.every(part => part?.basis === 'unit-usable' || part?.basis === 'unit-wall-share'),
      'conflict', unit.id, '套界中心线法与净使用面积加墙体分项法只能择一。分项法须同时列出使用和墙体面积。');
      const parts = [];
      for (const part of unit.parts) {
        let factor = 1;
        if (part.basis === 'balcony-perimeter' || part.basis === 'balcony-eligible-footprint') {
          requireEvidence(part.treatment === 'excluded' || (part.basis === 'balcony-perimeter' && part.treatment === 'enclosed') ||
            (part.basis === 'balcony-eligible-footprint' && part.treatment === 'open-eligible'),
          'needs-review', part.id, '阳台须确认封闭全计、不封闭合资格投影半计或不计入。');
          factor = part.treatment === 'excluded' ? 0 : part.treatment === 'open-eligible' ? 0.5 : 1;
        } else requireEvidence(part.treatment === undefined, 'conflict', part.id, '阳台计入方式不能用于非阳台分项。');
        const measured = await measure(part, ['unit-wall-centerline', 'unit-usable', 'unit-wall-share',
          'balcony-perimeter', 'balcony-eligible-footprint'], unit.id);
        parts.push({ ...measured, treatment: part.treatment, factor, countedArea: measured.rawArea * factor });
      }
      const values = parts.map(part => part.countedArea);
      const adopted = cents(values);
      requireEvidence(adopted > 0n, 'conflict', unit.id, '套内建筑面积取位后须为正。');
      units.push({ id: unit.id, ownershipSource: unit.ownershipSource, parts, adopted, raw: decimalSum(values).raw });
    }
    const deductions = [];
    for (const item of plan.deductions) {
      requireEvidence(item?.kind === 'independent-use' || item?.kind === 'non-allocatable',
        'needs-review', 'deductions', '扣除项须有已确认的独立使用或不分摊分类。');
      deductions.push({ ...await measure(item, ['deduction'], 'deductions'), kind: item.kind });
    }
    const common = [];
    for (const item of plan.common.parts) common.push(await measure(item, ['common-wall-centerline', 'outer-half-wall'], 'common'));
    const rawInputs = [gross.rawArea, ...units.flatMap(unit => unit.parts.map(part => -part.countedArea)),
      ...deductions.map(item => -item.rawArea)];
    const rawShared = decimalSum(rawInputs).raw;
    const commonValues = common.map(item => item.rawArea);
    const ledger = cents(commonValues);
    requireEvidence(rawShared >= 0 && cents(rawInputs) === ledger,
      'conflict', 'common', '独立幢总量扣除套内和独立空间后的余量，与已复核共有台账在 0.01 m² 取位下不一致。');
    const adoptedGross = cents([gross.rawArea]);
    const adoptedDeductions = cents(deductions.map(item => item.rawArea));
    const denominator = units.reduce((sum, unit) => sum + unit.adopted, 0n);
    const shared = adoptedGross - adoptedDeductions - denominator;
    requireEvidence(shared >= 0n, 'conflict', 'gross', '取位后的幢总量小于套内及扣除项之和。');
    return { status: 'bound' as const, plan, units, common, deductions, gross,
      adoptedGross, adoptedDeductions, denominator, shared, rawShared, ledger, ledgerRaw: decimalSum(commonValues).raw };
  } catch (error) {
    const diagnostic = error instanceof EvidenceError ? error : new EvidenceError('invalid', PROPERTY_AREA_PATH,
      error instanceof Error ? error.message : '无法读取或复算测算证据。');
    return { ...base, modelRevision, status: 'input-incomplete' as const,
      diagnostics: [{ kind: diagnostic.kind, field: diagnostic.field, message: diagnostic.message }] };
  }
}

/** Check the evidence and reconciliation without approving it or producing allocations. */
export async function inspectShanghaiPropertyArea(text: TextReader, planText?: string) {
  const binding = await bindShanghaiPropertyArea(text, planText);
  if (binding.status === 'input-incomplete') return binding;
  const { plan, units } = binding;
  return { ...base, status: 'ready-for-review' as const, modelRevision: plan.modelRevision,
    buildingId: plan.building.id, unitCount: units.length, hasReviewSource: hasText(plan.review?.source) };
}

/** Run the reviewed single-building plan without changing BIMDown evidence. */
export async function executeShanghaiPropertyArea(text: TextReader, planText?: string, userConfirmed = true) {
  const binding = await bindShanghaiPropertyArea(text, planText, { confirmed: userConfirmed });
  if (binding.status === 'input-incomplete') return binding;
  const { plan, units, gross, common, deductions, adoptedGross, adoptedDeductions, denominator,
    shared, rawShared, ledger, ledgerRaw } = binding;
  let distributed = 0n;
  const rows = units.map(({ adopted, raw, ...unit }) => {
    const quota = shared * adopted;
    const rawShare = Number(quota) / Number(denominator) / 100;
    const share = halfUp(quota, denominator);
    distributed += share;
    return { ...unit, internalAreaRaw: raw, internalArea: squareMetres(adopted),
      sharedAreaRaw: rawShare, sharedArea: squareMetres(share),
      totalAreaRaw: squareMetres(adopted) + rawShare, totalArea: squareMetres(adopted + share) };
  });
  return { ...base, status: 'success' as const, modelRevision: plan.modelRevision, plan,
    units: rows, common, deductions, gross,
    reconciliation: { adoptedGross: squareMetres(adoptedGross), adoptedDeductions: squareMetres(adoptedDeductions),
      denominator: squareMetres(denominator), rawShared, shared: squareMetres(shared),
      ledgerRaw, ledgerAdopted: squareMetres(ledger),
      ledgerRoundingDifference: squareMetres(shared - ledger), coefficient: Number(shared) / Number(denominator),
      distributed: squareMetres(distributed), reportRoundingDifference: squareMetres(distributed - shared) } };
}
