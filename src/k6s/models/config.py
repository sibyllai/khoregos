"""Configuration models for k6s.yaml parsing and validation."""

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class ProjectConfig(BaseModel):
    """Project identification configuration."""

    name: str
    description: str | None = None


class SessionConfig(BaseModel):
    """Session defaults configuration."""

    default_budget_usd: float = 50.00
    context_retention_days: int = 90
    audit_retention_days: int = 365


class BoundaryConfig(BaseModel):
    """Agent boundary configuration."""

    pattern: str  # Agent name pattern (e.g., "frontend-*")
    allowed_paths: list[str] = Field(default_factory=list)
    forbidden_paths: list[str] = Field(default_factory=list)
    enforcement: str = "advisory"  # "advisory" | "strict"
    max_tokens_per_hour: int | None = None
    max_cost_per_hour: float | None = None


class GateTrigger(BaseModel):
    """Gate trigger conditions."""

    event_types: list[str] | None = None
    file_patterns: list[str] | None = None
    cost_threshold: float | None = None
    custom: str | None = None  # Plugin hook name


class GateConfig(BaseModel):
    """Gate rule configuration."""

    id: str
    name: str
    trigger: GateTrigger
    approval_mode: str = "manual"  # "manual" | "auto-approve" | "auto-deny"
    timeout_seconds: int = 1800
    notify: list[str] = Field(default_factory=lambda: ["terminal"])


class PrometheusConfig(BaseModel):
    """Prometheus metrics configuration."""

    enabled: bool = False
    port: int = 9090


class OpenTelemetryConfig(BaseModel):
    """OpenTelemetry configuration."""

    enabled: bool = False
    endpoint: str = "http://localhost:4317"


class WebhookConfig(BaseModel):
    """Webhook notification configuration."""

    url: str
    events: list[str] = Field(default_factory=list)
    secret: str | None = None


class ObservabilityConfig(BaseModel):
    """Observability configuration."""

    prometheus: PrometheusConfig = Field(default_factory=PrometheusConfig)
    opentelemetry: OpenTelemetryConfig = Field(default_factory=OpenTelemetryConfig)
    webhooks: list[WebhookConfig] = Field(default_factory=list)


class PluginConfig(BaseModel):
    """Plugin configuration."""

    name: str
    module: str
    config: dict[str, Any] = Field(default_factory=dict)


class K6sConfig(BaseModel):
    """Root configuration model for k6s.yaml."""

    version: str = "1"
    project: ProjectConfig
    session: SessionConfig = Field(default_factory=SessionConfig)
    boundaries: list[BoundaryConfig] = Field(default_factory=list)
    gates: list[GateConfig] = Field(default_factory=list)
    observability: ObservabilityConfig = Field(default_factory=ObservabilityConfig)
    plugins: list[PluginConfig] = Field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "K6sConfig":
        """Load configuration from a YAML file."""
        with open(path) as f:
            data = yaml.safe_load(f)
        return cls.model_validate(data)

    @classmethod
    def load_or_default(cls, path: Path, project_name: str = "my-project") -> "K6sConfig":
        """Load configuration from file or return default if not found."""
        if path.exists():
            return cls.load(path)
        return cls(project=ProjectConfig(name=project_name))

    def save(self, path: Path) -> None:
        """Save configuration to a YAML file."""
        data = self.model_dump(exclude_none=True)
        with open(path, "w") as f:
            yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)

    def get_boundary_for_agent(self, agent_name: str) -> BoundaryConfig | None:
        """Get the boundary configuration that matches an agent name."""
        import fnmatch

        for boundary in self.boundaries:
            if fnmatch.fnmatch(agent_name, boundary.pattern):
                return boundary

        # Check for wildcard default
        for boundary in self.boundaries:
            if boundary.pattern == "*":
                return boundary

        return None

    def get_gate_by_id(self, gate_id: str) -> GateConfig | None:
        """Get a gate configuration by ID."""
        for gate in self.gates:
            if gate.id == gate_id:
                return gate
        return None


def generate_default_config(project_name: str) -> K6sConfig:
    """Generate a default configuration for a new project."""
    return K6sConfig(
        version="1",
        project=ProjectConfig(name=project_name, description="Project governed by Khoregos"),
        session=SessionConfig(),
        boundaries=[
            # Default boundary: forbid sensitive files for all agents
            BoundaryConfig(
                pattern="*",
                forbidden_paths=[".env*", "**/*.pem", "**/*.key"],
                enforcement="advisory",
            )
        ],
        gates=[
            GateConfig(
                id="dependency-approval",
                name="New Dependency Approval",
                trigger=GateTrigger(
                    file_patterns=[
                        "package.json",
                        "requirements.txt",
                        "go.mod",
                        "Cargo.toml",
                        "**/pom.xml",
                    ]
                ),
                approval_mode="manual",
                timeout_seconds=1800,
                notify=["terminal"],
            ),
            GateConfig(
                id="security-files",
                name="Security File Changes",
                trigger=GateTrigger(
                    file_patterns=[".env*", "**/auth/**", "**/security/**", "**/*.pem", "**/*.key"]
                ),
                approval_mode="manual",
                notify=["terminal"],
            ),
        ],
        observability=ObservabilityConfig(),
        plugins=[],
    )
