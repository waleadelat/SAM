import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useCreateSamSession } from "@workspace/api-client-react";
import { Activity, ShieldAlert, Zap, Loader2 } from "lucide-react";

export default function Home() {
  const [_, setLocation] = useLocation();
  const createSession = useCreateSamSession();

  const handleStart = () => {
    createSession.mutate(undefined, {
      onSuccess: (data) => {
        setLocation(`/session/${data.sessionId}`);
      },
    });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans">
      <header className="border-b bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50 sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 text-primary">
            <Activity className="h-6 w-6" />
            <span className="font-bold text-xl tracking-tight text-foreground">SAM</span>
          </div>
          <Button variant="outline" className="text-muted-foreground">Documentation</Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center p-4">
        <div className="max-w-3xl w-full text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 text-accent font-medium text-sm mb-4">
            <Zap className="h-4 w-4" />
            <span>Smart Asset Manager</span>
          </div>
          
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-foreground">
            Command Center for <br />
            <span className="text-primary">Infrastructure</span>
          </h1>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Upload messy engineering data. Get lifecycle intelligence, deterioration forecasts, and multi-million dollar treatment priorities instantly.
          </p>

          <div className="pt-8">
            <Button 
              size="lg" 
              className="h-14 px-8 text-lg font-medium shadow-xl"
              onClick={handleStart}
              disabled={createSession.isPending}
            >
              {createSession.isPending ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Initializing System...
                </>
              ) : (
                "Initialize New Session"
              )}
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-16 text-left">
            <FeatureCard 
              icon={<ShieldAlert className="h-6 w-6 text-accent" />}
              title="Predictive Deterioration"
              desc="Markov chain modeling to predict asset degradation before critical failures occur."
            />
            <FeatureCard 
              icon={<Activity className="h-6 w-6 text-primary" />}
              title="Condition Breakdown"
              desc="Instant analysis of your entire portfolio's health distribution."
            />
            <FeatureCard 
              icon={<Zap className="h-6 w-6 text-amber-500" />}
              title="Treatment Prioritization"
              desc="Data-driven maintenance schedules optimized for lifecycle cost."
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
  return (
    <div className="p-6 border rounded-xl bg-card hover:border-primary/50 transition-colors">
      <div className="mb-4 bg-muted w-12 h-12 rounded-lg flex items-center justify-center">
        {icon}
      </div>
      <h3 className="font-semibold text-lg mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
