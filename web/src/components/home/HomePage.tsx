import { Container } from "@/components/ui/Container";
import { Hero } from "./Hero";
import { WorkflowDemo } from "./WorkflowDemo";
import { WhySection } from "./WhySection";
import { ToolCards } from "./ToolCards";

export function HomePage() {
  return (
    <Container className="py-10 pb-16">
      <Hero />
      <WorkflowDemo />
      <WhySection />
      <ToolCards />
    </Container>
  );
}
