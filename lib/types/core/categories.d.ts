/**
 * What each scenario category is for. A bucket of scenarios only helps if a
 * reader knows what buying into it measures, so every category carries one line
 * of plain language and the kind of component it discriminates.
 */
export interface CategoryInfo {
    key: string;
    title: string;
    what: string;
    useFor: string;
}
export declare const CATEGORIES: CategoryInfo[];
export declare function categoryInfo(key: string | undefined): CategoryInfo;
