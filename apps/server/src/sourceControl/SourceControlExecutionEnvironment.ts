// T3-CUSTOM(expbkt3): the module lives in provider-core so provider adapters and
// @t3tools/source-control-github share one `CurrentSourceControlExecutionEnvironment`.
// Server code keeps importing it from here.
export * from "@t3tools/provider-core/server/sourceControlExecutionEnvironment.expbkt3";
