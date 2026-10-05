#include <SDK/foobar2000.h>
#include "../../shared/settings_schema.h"
#include "settings.h"
#include "visualisation.h"

static NSString* str(const std::string& value) { return [NSString stringWithUTF8String:value.c_str()]; }
static std::string configKey(NSString* key) { return std::string("foo_24sevenfm_covers.")+key.UTF8String; }

@interface SSCFoobarPreferences : NSObject
@property(strong) NSDictionary* defaults;
- (void)registerDefaults:(NSDictionary*)values;
- (BOOL)boolForKey:(NSString*)key;
- (NSInteger)integerForKey:(NSString*)key;
- (double)doubleForKey:(NSString*)key;
- (NSString*)stringForKey:(NSString*)key;
- (void)setObject:(id)value forKey:(NSString*)key;
@end
@interface SSCSettingsStack : NSStackView
@end
@implementation SSCSettingsStack
- (BOOL)isFlipped {return YES;}
@end
@implementation SSCFoobarPreferences
- (void)registerDefaults:(NSDictionary*)values { self.defaults=values; }
- (NSInteger)integerForKey:(NSString*)key { return fb2k::configStore::get()->getConfigInt(configKey(key).c_str(),[self.defaults[key] integerValue]); }
- (BOOL)boolForKey:(NSString*)key { return [self integerForKey:key]!=0; }
- (double)doubleForKey:(NSString*)key { return [self stringForKey:key].doubleValue; }
- (NSString*)stringForKey:(NSString*)key { auto value=fb2k::configStore::get()->getConfigString(configKey(key).c_str(),[self.defaults[key] description].UTF8String ?: ""); return [NSString stringWithUTF8String:value->c_str()]; }
- (void)setObject:(id)value forKey:(NSString*)key {
    auto store=fb2k::configStore::get();auto name=configKey(key);
    if([value isKindOfClass:NSString.class])store->setConfigString(name.c_str(),[value UTF8String]);
    else store->setConfigInt(name.c_str(),[value longLongValue]);
}
@end
id SSCCoversPreferences() {
    static SSCFoobarPreferences* store;static dispatch_once_t once;
    dispatch_once(&once,^{
        store=[SSCFoobarPreferences new];NSMutableDictionary* defaults=[NSMutableDictionary dictionary];
        for(const auto& d:ssccfg::settingsSchema(ssccfg::Profile::MacOS))
            if(d.supported && !d.desktopOnly)defaults[str(d.storageKey)]=d.stringValue?(id)str(d.defaultText):(id)@(d.defaultInt);
        [store registerDefaults:defaults];
    });return store;
}

@interface SSCFoobarSettings : NSViewController <NSTextFieldDelegate>
@property(strong) NSMutableDictionary<NSString*,NSControl*>* controls;
@property(strong) NSStackView* providers;
@property(strong) NSMutableArray<NSString*>* order;
@end
@implementation SSCFoobarSettings
- (void)loadView {
    self.controls=[NSMutableDictionary dictionary];
    NSView* view=[[NSView alloc] initWithFrame:NSMakeRect(0,0,660,590)];self.view=view;
    NSScrollView* scroll=[NSScrollView new];scroll.translatesAutoresizingMaskIntoConstraints=NO;scroll.hasVerticalScroller=YES;scroll.drawsBackground=NO;[view addSubview:scroll];
    [NSLayoutConstraint activateConstraints:@[[scroll.leadingAnchor constraintEqualToAnchor:view.leadingAnchor],[scroll.trailingAnchor constraintEqualToAnchor:view.trailingAnchor],[scroll.topAnchor constraintEqualToAnchor:view.topAnchor],[scroll.bottomAnchor constraintEqualToAnchor:view.bottomAnchor]]];
    NSStackView* root=[SSCSettingsStack new];root.orientation=NSUserInterfaceLayoutOrientationVertical;root.alignment=NSLayoutAttributeLeading;root.spacing=10;root.edgeInsets=NSEdgeInsetsMake(20,24,20,24);root.translatesAutoresizingMaskIntoConstraints=NO;scroll.documentView=root;
    [root.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor].active=YES;
    NSTextField* title=[NSTextField labelWithString:@"24seven.fm Covers"];title.font=[NSFont boldSystemFontOfSize:20];[root addArrangedSubview:title];
    [root addArrangedSubview:[NSTextField labelWithString:@"Saved in foobar2000. Changes apply immediately to all cover panels."]];
    NSString* lastGroup=@"";
    auto descriptors=ssccfg::settingsSchema(ssccfg::Profile::MacOS);
    std::stable_sort(descriptors.begin(),descriptors.end(),[](const auto& a,const auto& b){return a.group<b.group;});
    for(const auto& d:descriptors) {
        if(!d.supported || !d.ui || d.desktopOnly)continue;
        NSString* key=str(d.storageKey);NSString* group=str(d.group);
        if(![group isEqual:lastGroup]) { NSTextField* heading=[NSTextField labelWithString:group.capitalizedString];heading.font=[NSFont boldSystemFontOfSize:14];[root addArrangedSubview:heading];lastGroup=group; }
        if(d.type==ssccfg::SettingType::Boolean) {
            NSButton* button=[NSButton checkboxWithTitle:str(d.label) target:self action:@selector(change:)];button.identifier=key;button.state=[SSCCoversPreferences() boolForKey:key];self.controls[key]=button;[root addArrangedSubview:button];
        } else if(d.type==ssccfg::SettingType::Choice) {
            [root addArrangedSubview:[NSTextField labelWithString:str(d.label)]];NSStackView* row=[NSStackView stackViewWithViews:@[]];row.spacing=12;
            for(const auto& choice:d.choices) { NSButton* button=[NSButton radioButtonWithTitle:str(choice.label) target:self action:@selector(change:)];button.identifier=key;button.tag=std::stoi(choice.value);button.state=[SSCCoversPreferences() integerForKey:key]==button.tag;[row addArrangedSubview:button];self.controls[[key stringByAppendingFormat:@".%ld",button.tag]]=button; }[root addArrangedSubview:row];
        } else if(d.type==ssccfg::SettingType::Integer) {
            [root addArrangedSubview:[NSTextField labelWithString:[str(d.label) stringByAppendingString:@" (ms)"]]];
            NSSlider* slider=[NSSlider sliderWithValue:[SSCCoversPreferences() integerForKey:key] minValue:d.minimum maxValue:d.maximum target:self action:@selector(change:)];slider.identifier=key;slider.numberOfTickMarks=1+(d.maximum-d.minimum)/d.step;slider.allowsTickMarkValuesOnly=YES;[slider.widthAnchor constraintEqualToConstant:430].active=YES;self.controls[key]=slider;[root addArrangedSubview:slider];
        } else if(d.type==ssccfg::SettingType::OrderedSelection) {
            self.order=[NSMutableArray array];NSArray* saved=[[SSCCoversPreferences() stringForKey:key] componentsSeparatedByString:@","];
            for(NSString* p in saved)if([@[@"fanart",@"tmdb",@"tvmaze",@"steamgriddb"] containsObject:p] && ![self.order containsObject:p])[self.order addObject:p];
            for(const auto& p:d.choices)if(![self.order containsObject:str(p.value)])[self.order addObject:str(p.value)];
            self.providers=[NSStackView new];self.providers.orientation=NSUserInterfaceLayoutOrientationVertical;self.providers.alignment=NSLayoutAttributeLeading;self.providers.spacing=6;[root addArrangedSubview:self.providers];[self rebuildProviders];
        } else if(d.type==ssccfg::SettingType::Secret) {
            [root addArrangedSubview:[NSTextField labelWithString:str(d.label)]];NSSecureTextField* field=[NSSecureTextField new];field.identifier=key;field.stringValue=[SSCCoversPreferences() stringForKey:key];field.placeholderString=@"Optional personal key";field.delegate=self;[field.widthAnchor constraintEqualToConstant:430].active=YES;self.controls[key]=field;[root addArrangedSubview:field];
        }
    }
    NSTextField* note=[NSTextField wrappingLabelWithString:@"Artwork and ratings apply to StreamingSoundtracks. Other stations use their own covers. macOS Reduce Motion is respected.\nArtwork: fanart.tv, TMDB, TVmaze and SteamGridDB."];[note.widthAnchor constraintEqualToConstant:580].active=YES;note.textColor=NSColor.secondaryLabelColor;[root addArrangedSubview:note];
}
- (void)rebuildProviders {
    for(NSView* view in self.providers.arrangedSubviews.copy){[self.providers removeArrangedSubview:view];[view removeFromSuperview];}
    NSArray* enabled=[[SSCCoversPreferences() stringForKey:@"providers"] componentsSeparatedByString:@","];
    NSDictionary* names=@{@"fanart":@"fanart.tv",@"tmdb":@"TMDB",@"tvmaze":@"TVmaze",@"steamgriddb":@"SteamGridDB"};
    for(NSUInteger i=0;i<self.order.count;++i) { NSString* key=self.order[i];NSButton* check=[NSButton checkboxWithTitle:names[key] target:self action:@selector(providerToggle:)];check.identifier=key;check.state=[enabled containsObject:key];[check.widthAnchor constraintEqualToConstant:200].active=YES;self.controls[[@"provider." stringByAppendingString:key]]=check;
        NSButton* up=[NSButton buttonWithTitle:@"↑" target:self action:@selector(moveProvider:)];up.identifier=key;up.tag=-1;up.enabled=i>0;up.toolTip=@"Move earlier in lookup order";
        NSButton* down=[NSButton buttonWithTitle:@"↓" target:self action:@selector(moveProvider:)];down.identifier=key;down.tag=1;down.enabled=i+1<self.order.count;down.toolTip=@"Move later in lookup order";
        [self.providers addArrangedSubview:[NSStackView stackViewWithViews:@[check,up,down]]];
    }
}
- (void)saveProviders {
    NSMutableArray* enabled=[NSMutableArray array];for(NSString* key in self.order)if(((NSButton*)self.controls[[@"provider." stringByAppendingString:key]]).state==NSControlStateValueOn)[enabled addObject:key];
    if(!enabled.count){[self rebuildProviders];return;}[SSCCoversPreferences() setObject:[enabled componentsJoinedByString:@","] forKey:@"providers"];SSCVisualisationSettingsChanged();
}
- (void)providerToggle:(NSButton*)sender {[self saveProviders];}
- (void)moveProvider:(NSButton*)sender {
    NSInteger i=[self.order indexOfObject:sender.identifier],j=i+sender.tag;if(j<0 || j>=self.order.count)return;
    [self.order exchangeObjectAtIndex:i withObjectAtIndex:j];[self saveProviders];
    BOOL reduced=NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context){context.duration=reduced?0:.12;self.providers.animator.alphaValue=0;}completionHandler:^{
        [self rebuildProviders];[NSAnimationContext runAnimationGroup:^(NSAnimationContext* context){context.duration=reduced?0:.15;self.providers.animator.alphaValue=1;}completionHandler:nil];
    }];
}
- (void)change:(NSControl*)sender {
    NSString* key=sender.identifier;NSInteger value=sender.integerValue;
    if([sender isKindOfClass:NSButton.class]) {
        NSButton* button=(NSButton*)sender;
        if([key isEqual:@"poster"] || [key isEqual:@"remainingSize"] || [key isEqual:@"transition"]) {
            value=button.tag;for(NSString* name in self.controls)if([name hasPrefix:[key stringByAppendingString:@"."]])((NSButton*)self.controls[name]).state=self.controls[name]==sender;
        } else value=button.state;
    }
    [SSCCoversPreferences() setObject:@(value) forKey:key];SSCVisualisationSettingsChanged();
}
- (void)controlTextDidChange:(NSNotification*)notification { NSTextField* field=notification.object;NSString* value=field.stringValue;if(value.length>ssccfg::fanartKeyMaxLength){value=[value substringToIndex:ssccfg::fanartKeyMaxLength];field.stringValue=value;}[SSCCoversPreferences() setObject:value forKey:field.identifier]; }
- (void)controlTextDidEndEditing:(NSNotification*)notification {SSCVisualisationSettingsChanged();}
@end
NSViewController* SSCCoversSettingsController(){return [SSCFoobarSettings new];}
@interface SSCFoobarSettingsWindow : NSWindow <NSWindowDelegate>
@end
@implementation SSCFoobarSettingsWindow
- (BOOL)windowShouldClose:(NSWindow*)sender {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context){context.duration=NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion?0:.2;self.animator.alphaValue=0;}completionHandler:^{[self orderOut:nil];}];return NO;
}
@end
void SSCCoversShowSettings() {
    static NSWindow* window;
    if(!window){window=[[SSCFoobarSettingsWindow alloc] initWithContentRect:NSMakeRect(0,0,660,590) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];window.delegate=(id<NSWindowDelegate>)window;window.title=@"24seven.fm Covers Settings";window.releasedWhenClosed=NO;window.contentViewController=SSCCoversSettingsController();window.contentMinSize=NSMakeSize(620,420);[window center];}
    if(!window.visible){window.contentViewController=SSCCoversSettingsController();window.alphaValue=0;}[window makeKeyAndOrderFront:nil];[NSAnimationContext runAnimationGroup:^(NSAnimationContext* context){context.duration=NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion?0:.25;window.animator.alphaValue=1;}completionHandler:nil];
}
namespace {
class Preferences : public preferences_page {
public:
    service_ptr instantiate() override {return fb2k::wrapNSObject(SSCCoversSettingsController());}
    const char* get_name() override {return "24seven.fm Covers";}
    GUID get_guid() override {return {0x89c88d2a,0x2bd2,0x4e15,{0x8f,0x70,0x2d,0xda,0x54,0x43,0x48,0x0a}};}
    GUID get_parent_guid() override {return guid_tools;}
};
FB2K_SERVICE_FACTORY(Preferences);
class SettingsMenu : public mainmenu_commands {
public:
    t_uint32 get_command_count() override{return 1;}
    GUID get_command(t_uint32) override{return {0xa05f4dcc,0x9d56,0x4f68,{0x91,0x7a,0x11,0x82,0x33,0x45,0x88,0x51}};}
    void get_name(t_uint32,pfc::string_base& out) override{out="24seven.fm Covers Settings…";}
    bool get_description(t_uint32,pfc::string_base& out) override{out="Configure cover panels independently inside foobar2000.";return true;}
    GUID get_parent() override{return mainmenu_groups::view;}
    void execute(t_uint32,service_ptr) override{SSCCoversShowSettings();}
};
mainmenu_commands_factory_t<SettingsMenu> settingsMenu;
}
