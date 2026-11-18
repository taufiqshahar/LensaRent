import type { Page } from "../render/layout";
import {
  adminPage,
  faqPage,
  guidePage,
  notFoundPage,
  policyPage,
  privacyPage,
  termsPage,
} from "./info";
import { bookingPage, statusPage } from "./booking";
import { landingPage } from "./landing";

/** Every page of the site. Each needs a matching `<entry>.html` file for Vite. */
export const pages: readonly Page[] = [
  landingPage,
  bookingPage,
  statusPage,
  termsPage,
  privacyPage,
  policyPage,
  guidePage,
  faqPage,
  notFoundPage,
  adminPage,
];
