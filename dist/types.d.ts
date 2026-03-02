export type FilterType = 'PK' | 'LSQ' | 'HSQ';
export interface FreqPoint {
    freq: number;
    db: number;
}
export interface Filter {
    type: FilterType;
    fc: number;
    gain: number;
    Q: number;
}
export interface FilterSpec {
    type?: FilterType;
    gainRange: [number, number];
    qRange?: [number, number];
    fcRange?: [number, number];
}
export interface Constraints {
    filterSpecs: FilterSpec[];
    freqRange?: [number, number];
    fs?: number;
}
export interface OptimizeResult {
    pregain: number;
    filters: Filter[];
}
export interface InterpolateOptions {
    step?: number;
    fMin?: number;
    fMax?: number;
}
export interface SmoothOptions {
    windowOctaves?: number;
}
