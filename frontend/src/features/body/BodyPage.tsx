import { ToastStack } from '../../ui';
import { NotesPill } from '../todos/NotesPill';
import { FoodExperimentsCard } from './FoodExperimentsCard';
import { FoodLogCard } from './FoodLogCard';
import { FoodSafetyCard } from './FoodSafetyCard';
import { SymptomTrackerCard } from './SymptomTrackerCard';
import { TriageCard } from './TriageCard';
import {
  useBodyData,
  useBodyToasts,
  useDefinitionActions,
  useExperimentActions,
  useSafetyTagActions,
  useSymptomFoodActions,
} from './useBodyData';
import styles from './BodyPage.module.css';

/**
 * Body tab — exact-parity port of templates/index.html #tab-body:
 * Symptom Tracker (overview.js + health.js), Food Log (food.js), and the
 * Triage / Food sensitivities / Food experiments cards (kitchen.js — own
 * copies here; the kitchen feature keeps its own, dedupe later).
 */
export function BodyPage() {
  const { data, isLoading, isError, error } = useBodyData();
  const { toasts, push, dismiss } = useBodyToasts();
  const pushError = (message: string) => push(message);

  const symptomFood = useSymptomFoodActions(pushError);
  const safety = useSafetyTagActions(pushError);
  const definitions = useDefinitionActions(pushError, () => push('Definitions saved', { tone: 'info' }));
  const experiments = useExperimentActions(pushError);

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading&hellip;</div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  const healthData = Array.isArray(data.health_data) ? data.health_data : [];

  return (
    <div className={styles.page}>
      <div className={styles.title}>Body</div>
      <div className={styles.subtitle}>
        Symptom tracker, food log, and confirmed safe / suspect foods. Long-COVID signal in one place.
      </div>

      <SymptomTrackerCard
        days={healthData}
        definitions={data.symptom_definitions}
        onLogSymptoms={symptomFood.logSymptoms}
        onSetFoodNotes={symptomFood.setFood}
        onSaveDefinitions={definitions.save}
      />

      <FoodLogCard
        healthData={healthData}
        serverDate={data.server_date}
        safetyTags={data.kitchen_safety_tags}
        foodGuide={data.food_guide}
        onSetFood={symptomFood.setFood}
        onAddFood={(food) => symptomFood.addFood(food, data.server_date)}
        pushToast={push}
      />

      <TriageCard data={data} onTag={safety.setTag} />

      <FoodSafetyCard safetyTags={data.kitchen_safety_tags} onTag={safety.setTag} pushToast={push} />

      <FoodExperimentsCard
        tests={data.food_tests}
        queue={data.food_test_queue || []}
        serverDate={data.server_date}
        onStart={experiments.start}
        onResolve={experiments.resolve}
        onExtend={experiments.extend}
        onCancel={experiments.cancel}
        onClearBaseline={experiments.clearBaseline}
        onLogRetro={experiments.logRetro}
        onQueueAdd={experiments.queueAdd}
        onQueueRemove={experiments.queueRemove}
        onQueueReorder={experiments.queueReorder}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <NotesPill onError={pushError} tab="body" />
    </div>
  );
}
