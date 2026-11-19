// Built-in example prompts. Maintainer-provided and frontend-only: the backend does not know about them,
// and runs do not record which example (if any) a prompt came from.
//
// Every example uses only packages bundled in the sandbox image and generates or bundles its own data,
// so none needs network access, uploaded files or extra packages.
//
// `check` is guidance for a person reading the result. It is not an automated grader, and it does not
// promise that a model will get the task right.

/** What a run is expected to produce: stdout text, an image preview, or a downloadable file. */
export type ExampleOutput = "text" | "image" | "file";

export interface PromptExample {
  /** Stable slug. Do not rename it once released. */
  id: string;
  title: string;
  /** One line, shown in the picker. */
  summary: string;
  /** Fills the prompt box; the user still presses Run. */
  prompt: string;
  outputs: ExampleOutput[];
  /** What to look at when the run finishes. */
  check: string[];
}

export const EXAMPLES: readonly PromptExample[] = [
  {
    id: "pi-50-digits",
    title: "Calculate pi",
    summary: "A short task where floating-point precision is not enough.",
    prompt: "Calculate pi rounded to 50 decimal places (not truncated) and print the result.",
    outputs: ["text"],
    check: [
      "The printed value should be exactly 3.14159265358979323846264338327950288419716939937511 (50 digits after the decimal point).",
      "Ending in …7510 means the value was truncated, not rounded.",
      "If only the first few digits match and the rest differ, a floating-point value or a series approximation was used, even when 50 digits are printed.",
    ],
  },
  {
    id: "sin-plot",
    title: "Plot sin(x)",
    summary: "A labeled chart saved as an image.",
    prompt:
      "Plot sin(x) for x from 0 to 4π with matplotlib, with labeled axes, a grid and a title. Save it as /workspace/output/sin.png and print the file path.",
    outputs: ["image"],
    check: [
      "The chart shows two full periods; the x-axis runs from 0 to about 12.57 (4π) and the y-axis stays within −1 to 1.",
      "Both axes are labeled, a grid is visible and there is a title.",
      "The printed path is /workspace/output/sin.png and the file appears in the Files tab.",
    ],
  },
  {
    id: "cute-bee",
    title: "Draw a cute bee",
    summary: "A longer drawing script that may need a few iterations.",
    prompt:
      "Draw a cute cartoon bee with matplotlib: yellow oval body with black stripes, two light-blue translucent wings, a round head with big eyes and a smile, two antennae and a small stinger. Save it as /workspace/output/bee.png (dpi=150) and print the file path.",
    outputs: ["image"],
    check: [
      "Judge it by eye: look for the body with stripes, two translucent wings, a head with eyes and a smile, antennae and a stinger.",
      "The printed path is /workspace/output/bee.png and the file appears in the Files tab.",
      "If a run stops while the code is being written, the Logs tab shows whether the model's response was cut off.",
    ],
  },
  {
    id: "primes-10000",
    title: "Count primes below 10,000",
    summary: "Two printed results with exact answers you can verify.",
    prompt:
      "Find all prime numbers below 10,000. Print the total count and the last five primes in ascending order.",
    outputs: ["text"],
    check: [
      "The count should be 1229.",
      "The last five primes should be 9931, 9941, 9949, 9967 and 9973, in that order.",
      "Both results must be printed. A count with no list, or the reverse, is incomplete.",
    ],
  },
  {
    id: "sales-report",
    title: "Sample sales data and chart",
    summary: "The agent invents a dataset, saves a CSV, prints totals and plots them.",
    prompt:
      "Generate sample monthly sales data for 3 products (Alpha, Beta and Gamma) over the 12 months of 2025, in long format with the columns month (2025-01 to 2025-12), product and units: 36 rows in total. Use numpy with a fixed random seed. Save it as /workspace/output/sales.csv. Print the total units per product and the overall total. Then save a line chart with one line per product, labeled axes, a legend and a title as /workspace/output/sales.png.",
    outputs: ["file", "image", "text"],
    check: [
      "Open sales.csv from the Files tab: a header plus 36 rows with the columns month, product and units, and 36 distinct month and product pairs, so every product has all 12 months.",
      "The printed per-product totals should equal the sums of units in the CSV, and the overall total should equal their sum.",
      "The chart should show three lines, one per product, with a legend naming Alpha, Beta and Gamma. Each line has 12 points that match the CSV.",
      "Numbers will differ between runs: a fixed seed does not make different generated scripts produce the same data. Check that the outputs agree with each other, not against fixed values.",
    ],
  },
  {
    id: "iris-confusion-matrix",
    title: "Classify iris flowers",
    summary: "Train a small classifier on a dataset bundled with scikit-learn.",
    prompt:
      "Load scikit-learn's built-in iris dataset. Split it with train_test_split using test_size=0.25, random_state=42 and stratify=y. Train a DecisionTreeClassifier with random_state=42, then print the number of test samples and the test accuracy. Save a confusion matrix plot for the test set, with the class names (setosa, versicolor, virginica) as axis labels, as /workspace/output/confusion_matrix.png and print the file path.",
    outputs: ["image", "text"],
    check: [
      "There should be 38 test samples, split 12, 13 and 13 across the three classes.",
      "The axes should show setosa, versicolor and virginica, not 0, 1 and 2.",
      "If the cells show counts, they should add up to 38, and the diagonal divided by 38 should equal the printed accuracy. If they do not, use the color bar to check that the largest values sit on the diagonal.",
      "With these settings a reference script using scikit-learn 1.9.1 got 34 of 38 correct (0.895). A different result suggests different settings, not necessarily a wrong answer.",
    ],
  },
];

/** Shown as quick buttons next to the prompt box. The rest are reachable from the full list. */
export const QUICK_EXAMPLE_IDS: readonly string[] = ["pi-50-digits", "sin-plot", "cute-bee"];

export const QUICK_EXAMPLES: readonly PromptExample[] = QUICK_EXAMPLE_IDS.flatMap((id) => {
  const example = EXAMPLES.find((e) => e.id === id);
  return example ? [example] : [];
});

export const OUTPUT_LABELS: Record<ExampleOutput, string> = {
  text: "Text",
  image: "Image",
  file: "File",
};
