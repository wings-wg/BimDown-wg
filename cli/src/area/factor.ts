/** Rules transcribed from the supplied 建筑面积分摊.pdf, not a current-code certification. */
export interface AreaFeatures {
  type: 'room' | 'balcony' | 'outdoor_stair' | 'skywalk' | 'wall';
  permanent?: boolean;
  /** Uniform applicable height over the entire measurement part, metres. */
  height?: number;
  variableHeight?: boolean;
  covered?: boolean;
  enclosed?: boolean;
  connectedToIndoor?: boolean;
  publicPassage?: boolean;
  plazaStair?: boolean;
  wallOwnership?: 'shared' | 'private';
}
export interface FactorDecision {
  status: 'resolved' | 'indeterminate';
  factor?: 0 | 0.5 | 1;
  rule: string;
  reason: string;
}
export function inferAreaFactor(f: AreaFeatures): FactorDecision {
  const unknown = (reason: string): FactorDecision => ({ status: 'indeterminate', rule: 'PDF-review', reason });
  const yes = (factor: 0 | 0.5 | 1, rule: string, reason: string): FactorDecision => ({ status: 'resolved', factor, rule, reason });
  if (!f || !['room', 'balcony', 'outdoor_stair', 'skywalk', 'wall'].includes(f.type)) return unknown('Unsupported part type');
  for (const key of ['permanent', 'variableHeight', 'covered', 'enclosed', 'connectedToIndoor', 'publicPassage', 'plazaStair'] as const)
    if (f[key] !== undefined && typeof f[key] !== 'boolean') return unknown(`Invalid boolean: ${key}`);
  if (f.height !== undefined && (!Number.isFinite(f.height) || f.height < 0)) return unknown('Invalid height');
  // Wall ownership is an attribution rule, not a height/roof eligibility rule.
  if (f.type === 'wall') {
    if (f.wallOwnership === 'shared') return yes(0.5, 'PDF-p5-wall', 'Shared wall: half of reviewed horizontal wall area');
    if (f.wallOwnership === 'private') return yes(1, 'PDF-p5-wall', 'Private partition: full reviewed horizontal wall area');
    return unknown('Wall ownership required');
  }
  if (f.publicPassage === true) return yes(0, 'PDF-p3-excluded-8', 'Confirmed street/public passage exclusion');
  if (f.publicPassage === undefined) return unknown('Public passage classification required');
  if (f.variableHeight !== false) return unknown('Confirm uniform height or split into separately measured regions');
  if (f.height === undefined) return unknown('Applicable height required');
  if (f.height < 2.2) return yes(0, 'PDF-p3-excluded-1', 'Height below 2.20 m');
  if (f.permanent !== true) return unknown('Permanent construction must be confirmed');
  switch (f.type) {
    case 'room':
      if (f.covered === true && f.enclosed === true) return yes(1, 'PDF-p2-general-1', 'Permanent covered enclosed room at least 2.20 m');
      return unknown('Room requires confirmed cover and enclosure; otherwise classify the actual part');
    case 'balcony':
      if (f.connectedToIndoor === false) return yes(0, 'PDF-p3-excluded-6', 'Balcony not connected to interior');
      if (f.connectedToIndoor !== true || f.enclosed === undefined) return unknown('Balcony connection and enclosure required');
      return f.enclosed ? yes(1, 'PDF-p5-balcony-1', 'Enclosed balcony') : yes(0.5, 'PDF-p5-balcony-2', 'Open balcony');
    case 'outdoor_stair':
      if (f.plazaStair === true) return yes(0, 'PDF-p3-excluded-11', 'Plaza-style outdoor stair');
      if (f.plazaStair === undefined || f.covered === undefined) return unknown('Stair type and permanent cover required');
      return f.covered ? yes(0.5, 'PDF-p3-half-4', 'Covered outdoor stair, measured per floor') : yes(0, 'PDF-p3-excluded-14', 'Outdoor stair without permanent cover');
    case 'skywalk':
      if (f.covered === false) return yes(0, 'PDF-p3-excluded-3', 'Skywalk without cover');
      if (f.covered !== true || f.enclosed === undefined) return unknown('Skywalk cover and enclosure required');
      return f.enclosed ? yes(1, 'PDF-p2-full-10', 'Permanent enclosed skywalk') : yes(0.5, 'PDF-p3-half-5', 'Covered open skywalk');
  }
}
