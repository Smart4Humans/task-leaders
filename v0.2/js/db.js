/**
 * TaskLeaders — Simple Data Layer
 * Lightweight JSON-based storage for MVP
 */

const TaskLeadersDB = {
  // Provider data model
  providers: [],
  
  // Categories
  categories: [
    { id: 'plumbing', name: 'Plumbing', icon: '🔧' },
    { id: 'electrical', name: 'Electrical', icon: '⚡' },
    { id: 'painting', name: 'Painting', icon: '🎨' },
    { id: 'cleaning', name: 'Cleaning', icon: '🧹' },
    { id: 'handyman', name: 'Handyman', icon: '🔨' },
    { id: 'furniture-assembly', name: 'Furniture Assembly', icon: '📦' },
    { id: 'moving', name: 'Moving Help', icon: '🚚' },
    { id: 'yard-work', name: 'Yard Work', icon: '🌿' }
  ],

  // Initialize with sample data
  init() {
    this.loadFromStorage();
    
    // Add sample providers if empty
    if (this.providers.length === 0) {
      this.addSampleProviders();
    }
  },

  // Load from localStorage
  loadFromStorage() {
    try {
      const stored = localStorage.getItem('taskleaders_providers');
      if (stored) {
        this.providers = JSON.parse(stored);
      }
    } catch (e) {
      console.log('No stored data found');
    }
  },

  // Save to localStorage
  saveToStorage() {
    try {
      localStorage.setItem('taskleaders_providers', JSON.stringify(this.providers));
    } catch (e) {
      console.error('Failed to save data:', e);
    }
  },

  // Generate unique ID
  generateId() {
    return 'prov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  },

  // Add new provider (application)
  addProvider(providerData) {
    const provider = {
      provider_id: this.generateId(),
      business_name: providerData.business_name || '',
      contact_name: providerData.contact_name || '',
      whatsapp_number: this.formatWhatsAppNumber(providerData.whatsapp_number),
      category: providerData.category || '',
      service_area: providerData.service_area || '',
      hourly_rate: parseFloat(providerData.hourly_rate) || 0,
      description: providerData.description || '',
      response_time_minutes: parseInt(providerData.response_time_minutes) || 5,
      reliability_score: parseFloat(providerData.reliability_score) || 0,
      response_rate: parseInt(providerData.response_rate) || 95,
      founding_provider_status: providerData.founding_provider_status || false,
      approved: false, // Requires admin approval
      created_at: new Date().toISOString()
    };

    this.providers.push(provider);
    this.saveToStorage();
    return provider;
  },

  // Format WhatsApp number (remove non-numeric, ensure country code)
  formatWhatsAppNumber(number) {
    if (!number) return '';
    let cleaned = number.replace(/\D/g, '');
    // Add +1 if starts with area code only (North America)
    if (cleaned.length === 10) {
      cleaned = '1' + cleaned;
    }
    return cleaned;
  },

  // Get approved providers
  getApprovedProviders() {
    return this.providers.filter(p => p.approved === true);
  },

  // Get pending providers (for admin)
  getPendingProviders() {
    return this.providers.filter(p => p.approved === false);
  },

  // Get providers by category
  getProvidersByCategory(categoryId) {
    return this.getApprovedProviders()
      .filter(p => p.category === categoryId);
  },

  // Get provider by ID
  getProviderById(providerId) {
    return this.providers.find(p => p.provider_id === providerId);
  },

  // Approve provider (admin)
  approveProvider(providerId) {
    const provider = this.getProviderById(providerId);
    if (provider) {
      provider.approved = true;
      this.saveToStorage();
      return provider;
    }
    return null;
  },

  // Remove provider (admin)
  removeProvider(providerId) {
    this.providers = this.providers.filter(p => p.provider_id !== providerId);
    this.saveToStorage();
  },

  // Update provider (admin)
  updateProvider(providerId, updates) {
    const provider = this.getProviderById(providerId);
    if (provider) {
      Object.assign(provider, updates);
      this.saveToStorage();
      return provider;
    }
    return null;
  },

  // Calculate composite score for recommendations
  calculateCompositeScore(provider) {
    // Normalize scores to 0-100 scale
    const responseSpeedScore = Math.max(0, 100 - (provider.response_time_minutes * 2)); // Lower is better
    const reliabilityScore = provider.reliability_score * 20; // 5 stars = 100
    const priceScore = Math.max(0, 100 - (provider.hourly_rate / 2)); // Lower price = higher score (for this formula)

    return (
      0.45 * responseSpeedScore +
      0.35 * reliabilityScore +
      0.20 * priceScore
    );
  },

  // Get recommended providers for a category
  getRecommendedProviders(categoryId, count = 3) {
    const providers = this.getProvidersByCategory(categoryId);
    
    // Calculate composite scores
    const scored = providers.map(p => ({
      ...p,
      composite_score: this.calculateCompositeScore(p)
    }));

    // Sort by composite score
    scored.sort((a, b) => b.composite_score - a.composite_score);

    // Take top 5, randomly select 3
    const top5 = scored.slice(0, 5);
    const shuffled = top5.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  },

  // Sort providers
  sortProviders(providers, sortBy) {
    const sorted = [...providers];
    
    switch (sortBy) {
      case 'response_time':
        sorted.sort((a, b) => a.response_time_minutes - b.response_time_minutes);
        break;
      case 'reliability':
        sorted.sort((a, b) => b.reliability_score - a.reliability_score);
        break;
      case 'price':
        sorted.sort((a, b) => a.hourly_rate - b.hourly_rate);
        break;
      default:
        // Default: composite score
        sorted.sort((a, b) => {
          const scoreA = this.calculateCompositeScore(a);
          const scoreB = this.calculateCompositeScore(b);
          return scoreB - scoreA;
        });
    }
    
    return sorted;
  },

  // Get category stats
  getCategoryStats(categoryId) {
    const providers = this.getProvidersByCategory(categoryId);
    if (providers.length === 0) {
      return {
        count: 0,
        avg_response_time: 0,
        available_now: 0
      };
    }

    const totalResponseTime = providers.reduce((sum, p) => sum + p.response_time_minutes, 0);
    
    return {
      count: providers.length,
      avg_response_time: Math.round(totalResponseTime / providers.length),
      available_now: Math.ceil(providers.length * 0.3) // Estimate 30% available
    };
  },

  // Format response time for display
  formatResponseTime(minutes) {
    if (minutes < 1) return '< 1 min';
    if (minutes < 60) return `~${minutes} min`;
    return `~${Math.round(minutes / 60)} hr`;
  },

  // Format price for display
  formatPrice(rate) {
    return `$${rate}/hr`;
  },

  // Add sample providers for testing
  addSampleProviders() {
    const sampleProviders = [
      {
        business_name: "Mike Johnson Plumbing",
        contact_name: "Mike Johnson",
        whatsapp_number: "16045551234",
        category: "plumbing",
        service_area: "Vancouver, Burnaby, Richmond",
        hourly_rate: 90,
        description: "Licensed plumber with 15 years experience. Emergency repairs, installations, and maintenance.",
        response_time_minutes: 3,
        reliability_score: 4.9,
        response_rate: 98,
        founding_provider_status: true,
        approved: true
      },
      {
        business_name: "Quick Fix Electrical",
        contact_name: "Sarah Chen",
        whatsapp_number: "16045555678",
        category: "electrical",
        service_area: "Vancouver, North Shore",
        hourly_rate: 85,
        description: "Residential and commercial electrical work. Panel upgrades, lighting, troubleshooting.",
        response_time_minutes: 5,
        reliability_score: 4.8,
        response_rate: 96,
        founding_provider_status: true,
        approved: true
      },
      {
        business_name: "Perfect Painters",
        contact_name: "David Kim",
        whatsapp_number: "16045559012",
        category: "painting",
        service_area: "All Vancouver areas",
        hourly_rate: 55,
        description: "Interior and exterior painting. Free quotes, clean work, competitive rates.",
        response_time_minutes: 8,
        reliability_score: 4.7,
        response_rate: 94,
        founding_provider_status: true,
        approved: true
      },
      {
        business_name: "Clean Slate Cleaning",
        contact_name: "Maria Garcia",
        whatsapp_number: "16045553456",
        category: "cleaning",
        service_area: "Vancouver, Burnaby",
        hourly_rate: 40,
        description: "Professional home and office cleaning. Eco-friendly products available.",
        response_time_minutes: 12,
        reliability_score: 4.6,
        response_rate: 92,
        founding_provider_status: false,
        approved: true
      },
      {
        business_name: "Handyman Hank",
        contact_name: "Hank Wilson",
        whatsapp_number: "16045557890",
        category: "handyman",
        service_area: "East Vancouver, Burnaby",
        hourly_rate: 65,
        description: "No job too small. Repairs, installations, furniture assembly, and more.",
        response_time_minutes: 15,
        reliability_score: 4.5,
        response_rate: 88,
        founding_provider_status: false,
        approved: true
      }
    ];

    sampleProviders.forEach(p => this.addProvider(p));
    
    // Auto-approve sample providers
    this.providers.forEach(p => {
      p.approved = true;
    });
    this.saveToStorage();
  },

  // Clear all data (for testing)
  clearAll() {
    this.providers = [];
    localStorage.removeItem('taskleaders_providers');
  }
};

// Initialize on load
TaskLeadersDB.init();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TaskLeadersDB;
}
