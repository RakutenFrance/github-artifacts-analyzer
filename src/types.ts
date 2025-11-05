export interface AnalysisOptions {
  includeExpired: boolean;
  minSize: number;
  includeForks?: boolean;
  excludeOrgs?: boolean;
}

export interface OrganizationInfo {
  login: string;
  name: string;
  description?: string;
}

export interface WorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface ArtifactInfo {
  id: number;
  name: string;
  sizeInBytes: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  expired: boolean;
  workflowRunId: number;
  workflowName: string;
}

export interface RepositoryAnalysis {
  owner: string;
  name: string;
  fullName: string;
  hasWorkflows: boolean;
  workflows: WorkflowInfo[];
  artifacts: ArtifactInfo[];
  totalArtifacts: number;
  totalSizeBytes: number;
  activeArtifacts: number;
  expiredArtifacts: number;
  activeSizeBytes: number;
  expiredSizeBytes: number;
}

export interface AnalysisSummary {
  totalRepositories: number;
  repositoriesWithWorkflows: number;
  repositoriesWithArtifacts: number;
  totalArtifacts: number;
  totalSizeBytes: number;
  activeArtifacts: number;
  expiredArtifacts: number;
  activeSizeBytes: number;
  expiredSizeBytes: number;
}

export interface AnalysisResult {
  organizationName?: string;
  repositories: RepositoryAnalysis[];
  summary: AnalysisSummary;
}
